import { slugTaken } from "@alxia/tenancy";
import { isObjectIdString, toObjectId } from "@softistx/mongo";
import type {
  CreateOrganisationInput,
  UpdateOrganisationInput,
} from "@/generated/graphql/resolvers";
import type { AppTenancy, CoreMongo } from "../../config/db";
import type { JanusMembership, Viewer } from "../auth";
import {
  type FieldIssue,
  fail,
  invalid,
  required,
  tooManyAttempts,
  unavailable,
} from "../shared/errors";
import { tenancyFailure } from "../tenancy";
import { tooManyOrganisations } from "./organisations.errors";
import {
  MAX_OWNED_ORGANISATIONS,
  type OrganisationLimits,
} from "./organisations.limits";
import {
  type OrganisationDocument,
  organisationSlug,
  timeZone,
} from "./organisations.model";

// Organisations by name, then id, as the switcher lists them.
const byName = (a: OrganisationDocument, b: OrganisationDocument) =>
  a.name.localeCompare(b.name) ||
  a._id.toHexString().localeCompare(b._id.toHexString());

// "North Star Ltd." -> "north-star-ltd": lower case, accents dropped, anything
// else a hyphen. A name that gives nothing usable (only symbols, or the shape
// of an id) gets a random tail so it still has an address.
export function slugOf(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return organisationSlug.safeParse(slug).success
    ? slug
    : `org-${crypto.randomUUID().slice(0, 8)}`;
}

// The organisation registry, in the core database, and the creation of an
// organisation with its database.
export class OrganisationsService {
  constructor(
    private readonly core: CoreMongo,
    private readonly tenancy: Pick<AppTenancy, "provision">,
    private readonly membership: Pick<
      JanusMembership,
      "organizationsOf" | "assign"
    >,
    // The rate limits (none without Redis, in development and specs).
    private readonly limits?: OrganisationLimits,
  ) {}

  // The ACTIVE organisations the account is a member of, by name, each with
  // the account's role there. One whose id no longer names a live registry
  // entry, or that is `provisioning` or `archived`, is left out.
  async mine(accountId: string) {
    const held = (await this.membership.organizationsOf(accountId)).filter(
      ({ organizationId }) => isObjectIdString(organizationId),
    );
    if (held.length === 0) return [];
    const found = await this.core.db.organisations.findMany({
      filter: {
        _id: {
          $in: held.map(({ organizationId }) => toObjectId(organizationId)),
        },
        status: "active",
      },
    });
    const roles = new Map(
      held.map(({ organizationId, role }) => [organizationId, role]),
    );
    return found.sort(byName).flatMap((organisation) => {
      const role = roles.get(organisation._id.toHexString());
      return role ? [{ organisation, role }] : [];
    });
  }

  // An account creates at most 5 organisations an hour (rate limit, 429
  // `auth.errors.too-many-attempts`) and owns at most 10 (409
  // `organisations.errors.too-many`).
  private async guardCreation(accountId: string) {
    const owned = (await this.mine(accountId)).filter(
      ({ role }) => role === "owner",
    );
    if (owned.length >= MAX_OWNED_ORGANISATIONS) {
      throw tooManyOrganisations(MAX_OWNED_ORGANISATIONS);
    }
    if (!this.limits) return;
    let result: { allowed: boolean; retryAfter: number };
    try {
      result = await this.limits.organisationCreate.consume({ accountId }, 1, {
        timeoutMs: 1_000,
      });
    } catch (error) {
      // Fail closed, like the intake: a limit that cannot be checked is a 503,
      // never a free creation (each one provisions a database).
      console.warn("organisation creation rate limit unavailable", error);
      throw unavailable();
    }
    if (!result.allowed)
      throw tooManyAttempts(Math.ceil(result.retryAfter / 1000));
  }

  // Registers the organisation, creates and migrates its database, activates
  // it, and makes the account its owner. A taken slug is 409
  // `tenancy.errors.slug-taken`.
  async create(accountId: string, input: CreateOrganisationInput) {
    const name = input.name.trim();
    const slug = input.slug?.trim() || slugOf(name);
    const zone = input.timeZone?.trim() || "UTC";
    const issues: FieldIssue[] = [];
    if (!name)
      issues.push({ path: "name", code: "validation.errors.required" });
    if (!organisationSlug.safeParse(slug).success) {
      issues.push({ path: "slug", code: "validation.errors.invalid" });
    }
    if (!timeZone.safeParse(zone).success) {
      issues.push({ path: "timeZone", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    // A taken slug is refused before the attempt is counted: a 409 never burns
    // one of the 5 hourly creations. (Two creations racing for one slug still
    // reach `provision`, whose unique index has the last word.)
    if (await this.core.db.organisations.findFirst({ slug })) {
      throw tenancyFailure(slugTaken(slug));
    }
    await this.guardCreation(accountId);
    let tenant: Awaited<ReturnType<AppTenancy["provision"]>>;
    try {
      tenant = await this.tenancy.provision({ slug, name }, accountId);
    } catch (error) {
      throw tenancyFailure(error);
    }
    // The organisation is active as soon as it is provisioned, so a failure
    // after this point (the owner's grant, the time zone) archives it: an active
    // organisation nobody owns is unreachable.
    try {
      await this.membership.assign(
        tenant._id.toHexString(),
        accountId,
        "owner",
      );
      const organisation: OrganisationDocument =
        zone === tenant.timeZone
          ? tenant
          : await this.core.as(accountId).db.organisations.update(tenant._id, {
              timeZone: zone,
              version: tenant.version,
            });
      return { organisation, role: "owner" as const };
    } catch (error) {
      await this.core
        .as(accountId)
        .db.organisations.update(tenant._id, {
          status: "archived",
          version: tenant.version,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  // Changes the name or the time zone. A field left out stays; null is refused
  // before anything is written.
  async update(
    actor: string,
    organisation: OrganisationDocument,
    input: UpdateOrganisationInput,
  ): Promise<OrganisationDocument> {
    const issues: FieldIssue[] = required(input, ["name", "timeZone"]);
    const name = input.name?.trim();
    const zone = input.timeZone?.trim();
    if (name === "")
      issues.push({ path: "name", code: "validation.errors.required" });
    if (zone !== undefined && !timeZone.safeParse(zone).success) {
      issues.push({ path: "timeZone", code: "validation.errors.invalid" });
    }
    if (issues.length > 0) throw invalid(issues);
    if (name === undefined && zone === undefined) return organisation;
    return this.core.as(actor).db.organisations.update(organisation._id, {
      ...(name && { name }),
      ...(zone && { timeZone: zone }),
      version: organisation.version,
    });
  }

  // Requires (or stops requiring) a second factor of every member. Turning it
  // on needs the actor's own second factor, so the actor is not locked out.
  async setSecondFactorRequired(
    actor: Viewer,
    organisation: OrganisationDocument,
    required: boolean,
  ): Promise<OrganisationDocument> {
    if (required && !actor.hasSecondFactor) {
      throw fail("auth.errors.second-factor-not-enrolled", { status: 409 });
    }
    if (organisation.requireSecondFactor === required) return organisation;
    return this.core.as(actor.id).db.organisations.update(organisation._id, {
      requireSecondFactor: required,
      version: organisation.version,
    });
  }
}

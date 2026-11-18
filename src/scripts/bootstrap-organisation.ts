import type { AppTenancy, CoreMongo } from "../config/db";
import type { Role } from "../core/access";
import type { Auth } from "../core/auth";
import {
  isMemberAddress,
  issueInvitation,
  sendInvitation,
} from "../core/invitations";
import {
  type OrganisationDocument,
  organisationSlug,
  provisionOrganisation,
  slugOf,
} from "../core/organisations";
import { SYSTEM_ACTOR } from "../core/shared/actors";
import { exhausted } from "../core/shared/errors";
import { retryWriteConflicts } from "../core/shared/locked";
import type { Locale } from "../i18n/locale";

export interface BootstrapInput {
  organisation: string;
  slug?: string | undefined;
  email: string;
  name: string;
  role: Role;
  locale: Locale;
}

// The operator's first step on a fresh deployment (`dist/scripts/bootstrap.js`):
// an organisation with no account (stamped SYSTEM_ACTOR), and a mailed
// invitation to its first member, whose acceptance creates the account.
// Idempotent: an organisation whose slug exists is reused (it must be active),
// and the address's pending invitation is replaced.
export async function bootstrapOrganisation(
  deps: {
    core: CoreMongo;
    tenancy: Pick<AppTenancy, "provision">;
    auth: Pick<
      Auth,
      "clock" | "mailer" | "from" | "links" | "accounts" | "membership"
    >;
  },
  input: BootstrapInput,
) {
  const name = input.organisation.trim();
  const slug = input.slug?.trim() || slugOf(name);
  if (!name) throw new Error("--organisation must not be empty");
  if (!organisationSlug.safeParse(slug).success) {
    throw new Error(`--slug "${slug}" is not a valid organisation slug`);
  }
  const existing: OrganisationDocument | undefined =
    await deps.core.db.organisations.findFirst({ slug });
  if (existing && existing.status !== "active") {
    throw new Error(
      `organisation "${slug}" exists but is ${existing.status}: finish it with \`bun run db:sync\` first`,
    );
  }
  const organisation =
    existing ??
    (await provisionOrganisation(deps.tenancy, { slug, name }, SYSTEM_ACTOR));
  const email = input.email.trim().toLowerCase();
  if (await isMemberAddress({ auth: deps.auth }, organisation._id, email)) {
    throw new Error(
      `${email} is already a member of "${organisation.slug}": nothing to invite`,
    );
  }
  const { invitation, token } = await retryWriteConflicts(
    () =>
      issueInvitation(
        { core: deps.core.as(SYSTEM_ACTOR), auth: deps.auth },
        {
          organisationId: organisation._id,
          email,
          name: input.name.trim(),
          role: input.role,
          locale: input.locale,
        },
      ),
    exhausted,
  );
  await sendInvitation(
    { auth: deps.auth },
    invitation,
    token,
    organisation.name,
  );
  return { organisation, invitation, created: !existing };
}

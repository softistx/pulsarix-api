import type { Tenant, TenantRegistry } from "@alxia/tenancy";
import type { CoreMongo } from "../../config/db";

type Registry = CoreMongo["db"]["organisations"];
type OrganisationRecord = NonNullable<
  Awaited<ReturnType<Registry["findById"]>>
>;

// An organisation as the tenancy store hands it back: the registry's document,
// which already holds the `id` (its `_id` in hex) a `Tenant` asks for. A
// resolver reads it as `scope.tenant` with all its fields (`_id`, `version`,
// `timeZone`...).
export type Organisation = OrganisationRecord & Tenant;

// The port the store registers and finds organisations through: an adapter over
// the core database's `organisations` collection (src/core/organisations). A
// taken slug is the collection's unique index, a `ConflictError`, which the
// store answers as `tenancy.errors.slug-taken`.
export function organisationRegistry(
  core: Pick<CoreMongo, "db">,
): TenantRegistry<Organisation> {
  const organisations = core.db.organisations;
  return {
    findById: (id) => organisations.findById(id),
    findBySlug: (slug) => organisations.findFirst({ slug }),
    list: ({ withDeleted }) => organisations.findMany({ withDeleted }),
    create: (input, actor) => organisations.as(actor).create({ ...input }),
    activate: (tenant, actor) =>
      organisations
        .as(actor)
        .update(tenant._id, { status: "active", version: tenant.version }),
  };
}

import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import type { Role } from "../access";
import { actors } from "../shared/actors";

// `provisioning`: registered, its database not ready yet (or provisioning
// failed half-way: `bun run db:sync` finishes it). `active`: the only status a
// request resolves. `archived`: kept, never resolved.
export const organisationStatus = z.enum([
  "provisioning",
  "active",
  "archived",
]);
export type OrganisationStatus = z.infer<typeof organisationStatus>;

// An organisation's address in URLs: lower case, digits and single hyphens,
// and never 24 hex digits, which is an organisation id (a request names an
// organisation by either, so a slug that looked like an id could shadow one).
// One regex, so the collection's validator carries it as well.
export const organisationSlug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^(?![0-9a-f]{24}$)[a-z0-9]+(?:-[a-z0-9]+)*$/);

// An IANA time zone name ("Europe/Paris"), checked by the runtime's ICU.
export const timeZone = z.string().refine((name) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}, "not an IANA time zone");

// The organisation registry, in the core database: the tenant itself. Its
// `_id` names its own database (`<prefix><id>`, the `perOrganization` store of
// @alxia/tenancy, `tenancyOf` in src/config/db.ts); `slug` names it in URLs and
// is retired with it.
export const organisations = defineCollection({
  name: "organisations",
  schema: z.object({
    _id: id(),
    name: z.string().trim().min(1).max(200),
    slug: organisationSlug,
    timeZone: timeZone.default("UTC"),
    status: organisationStatus.default("provisioning"),
  }),
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { slug: 1 }, unique: true, name: "organisations_slugUnique" },
  ],
});

export type OrganisationDocument = ReadDocumentOf<typeof organisations>;

// What `myOrganisations` reads: an organisation with the viewer's role in it.
export interface MyOrganisationView {
  organisation: OrganisationDocument;
  role: Role;
}

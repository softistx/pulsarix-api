import type { OrganisationDocument } from "./organisations.model";
import { organisationSlug } from "./organisations.model";

// Organisations by name, then id, as the switcher lists them.
export const byName = (a: OrganisationDocument, b: OrganisationDocument) =>
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

import { type Access, createAccess } from "@alxia/access";
import type { Module } from "@alxia/modules";
import { type Role, roles } from "./roles";

export type { Access } from "@alxia/access";
export { AccessCatalogueError } from "@alxia/access";

// The access catalogue of this API (@alxia/access): the role -> permission
// matrix every guard reads, built from the manifests (plan Q13). `permissions`
// declares what a module guards, `defaultGrants` says which built-in roles hold
// which of them by default. The owner holds every declared permission. It
// throws an `AccessCatalogueError` at boot when a permission is badly spelled
// or a grant is wrong.
export function accessOf(list: readonly Module[]): Access<Role> {
  return createAccess(list, { roles, all: "owner" });
}

// The port the tenancy and the guards read: the role an account holds in an
// organisation, or null when it is no member (src/core/auth/membership/
// implements it over janus).
export interface Membership {
  roleOf(organizationId: string, accountId: string): Promise<Role | null>;
}

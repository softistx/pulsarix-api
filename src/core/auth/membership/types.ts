import type { createMongoAdapter } from "@softistx/janus-mongo";
import type { Membership, Role } from "../../access";
import type { organisationPermissions } from "../accounts";

export type Relations = ReturnType<typeof createMongoAdapter>["relations"];
export type Permissions = ReturnType<typeof organisationPermissions>;

// Membership over janus's relations: `organization:<id>#<relation>@user:<id>`,
// the relation being the role in camelCase. ONE role per organization is the
// rule; an account that holds two or more (data written outside `assign`) is
// in CONFLICT: `roleOf` fails closed (null), the lists show it as a conflict,
// and the members module repairs it (`rolesOf`, `assign`, `remove`).
export interface JanusMembership extends Membership {
  // Makes `role` the account's only role in the organization (any other role
  // it held there is revoked). Idempotent.
  assign(organizationId: string, accountId: string, role: Role): Promise<void>;
  // Takes the account out of the organization, whatever roles it holds.
  // Idempotent.
  remove(organizationId: string, accountId: string): Promise<void>;
  // EVERY role the account holds in the organization: none for a non-member,
  // one for a member, several for a conflict.
  rolesOf(organizationId: string, accountId: string): Promise<Role[]>;
  // The accounts holding `role` in the organization (a conflicted account is
  // listed under each role it holds).
  holders(organizationId: string, role: Role): Promise<string[]>;
  // Every account holding a role in the organization with ALL its roles
  // (unordered): one role is a member, several a conflict.
  membersOf(
    organizationId: string,
  ): Promise<{ accountId: string; roles: Role[] }[]>;
  // Every organization the account is a member of, with its role there
  // (unordered; the registry decides which are active). An organization where
  // the account is in conflict is left out, as `roleOf` refuses it.
  organizationsOf(
    accountId: string,
  ): Promise<{ organizationId: string; role: Role }[]>;
}

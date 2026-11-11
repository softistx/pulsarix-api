import { type Role, relationOf, roles } from "../../access";
import type { JanusMembership, Permissions, Relations } from "./types";

// The organization and the account as janus's relations name them.
export const organizationObject = (organizationId: string) =>
  ({ type: "organization", id: organizationId }) as const;
export const subjectOf = (accountId: string) =>
  ({ type: "user", id: accountId }) as const;

type Reads = Pick<
  JanusMembership,
  "roleOf" | "rolesOf" | "holders" | "membersOf" | "organizationsOf"
>;

// The ids of the organizations where `subject` holds `role`, every page.
async function organizationsHolding(
  permissions: Permissions,
  accountId: string,
  role: Role,
) {
  const found: string[] = [];
  let after: string | null = null;
  do {
    const page: { items: readonly string[]; nextCursor: string | null } =
      await permissions.list(
        subjectOf(accountId),
        relationOf(role),
        "organization",
        { after, limit: 100 },
      );
    found.push(...page.items);
    after = page.nextCursor;
  } while (after);
  return found;
}

// What a request reads: who holds which role. An account with two or more
// roles in an organization has no role for `roleOf` (fail closed: no access,
// never the most privileged) and a warning names it so someone repairs it.
export function membershipReads(
  permissions: Permissions,
  relations: Relations,
  warn: (message: string) => void,
): Reads {
  async function rolesOf(organizationId: string, accountId: string) {
    const held = await Promise.all(
      roles.map((role) =>
        permissions.can(
          subjectOf(accountId),
          relationOf(role),
          organizationObject(organizationId),
        ),
      ),
    );
    return roles.filter((_, i) => held[i]);
  }

  async function holders(organizationId: string, role: Role) {
    const entities = await relations.findEntities(
      organizationObject(organizationId),
      relationOf(role),
    );
    return entities.map((entity) => entity.id);
  }

  return {
    rolesOf,
    holders,
    async roleOf(organizationId, accountId) {
      const held = await rolesOf(organizationId, accountId);
      if (held.length > 1) {
        warn(
          `membership: account ${accountId} holds ${held.length} roles in organization ${organizationId} (${held.join(", ")}); no access until repaired`,
        );
        return null;
      }
      return held[0] ?? null;
    },
    async membersOf(organizationId) {
      const byAccount = new Map<string, Role[]>();
      for (const role of roles) {
        for (const accountId of await holders(organizationId, role)) {
          byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), role]);
        }
      }
      return [...byAccount].map(([accountId, held]) => ({
        accountId,
        roles: held,
      }));
    },
    async organizationsOf(accountId) {
      const byOrganization = new Map<string, Role[]>();
      for (const role of roles) {
        for (const id of await organizationsHolding(
          permissions,
          accountId,
          role,
        )) {
          byOrganization.set(id, [...(byOrganization.get(id) ?? []), role]);
        }
      }
      return [...byOrganization].flatMap(([organizationId, held]) =>
        held.length === 1 && held[0] ? [{ organizationId, role: held[0] }] : [],
      );
    },
  };
}

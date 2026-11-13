import type { CoreMongo } from "../../config/db";
import type { Role } from "../access";
import type { Auth } from "../auth";
import { fail } from "../shared/errors";
import { ensureLock, raiseLock } from "../shared/lock-documents";
import { lastOwner } from "./members.errors";

// Who may manage members: the roles holding `member:manage`.
const managers: readonly Role[] = ["owner", "admin"];

// Creates the organisation's lock document when it is not there yet, OUTSIDE
// the transaction (src/core/shared/lock-documents.ts).
export const ensureOwnerLock = (core: CoreMongo, organisationId: string) =>
  ensureLock(core.db.memberLocks.raw, organisationId);

// Inside `tx`, before anything is read: raises the organisation's lock, so a
// concurrent change of its members conflicts here and runs again after this
// one committed.
export const serialiseOwners = (tx: CoreMongo, organisationId: string) =>
  raiseLock(tx.db.memberLocks.raw, organisationId, tx.db.memberLocks.session);

// Inside the lock: the ACTING viewer still manages members, and their role,
// else 403: an admin demoted mid-request cannot finish.
export async function stillManager(
  auth: Pick<Auth, "membership">,
  organisationId: string,
  viewerId: string,
): Promise<Role> {
  const role = await auth.membership.roleOf(organisationId, viewerId);
  if (!role || !managers.includes(role)) {
    throw fail("auth.errors.forbidden", {
      params: { permission: "member:manage" },
      status: 403,
    });
  }
  return role;
}

// Refuses (409 `members.errors.last-owner`) a change that takes `leaving` out
// of the organisation's owners and leaves none REAL and ACTIVE: an owner counts
// when `roleOf` says `owner` (an account holding two roles has none: it is
// refused access) and its account can sign in. Call it after `serialiseOwners`,
// for an account that is an owner now.
export async function keepAnOwner(
  auth: Pick<Auth, "accounts" | "membership">,
  organisationId: string,
  leaving: string,
) {
  const others = (
    await auth.membership.holders(organisationId, "owner")
  ).filter((id) => id !== leaving);
  const real: string[] = [];
  for (const id of others) {
    if ((await auth.membership.roleOf(organisationId, id)) === "owner") {
      real.push(id);
    }
  }
  const accounts = await auth.accounts.user.findMany(real);
  if (!accounts.some((account) => account.active)) throw lastOwner();
}

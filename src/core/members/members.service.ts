import type { CoreMongo } from "../../config/db";
import type { Role } from "../access";
import type { Auth } from "../auth";
import { exhausted } from "../shared/errors";
import { retryWriteConflicts } from "../shared/locked";
import type { Organisation } from "../tenancy";
import { memberNotFound, ownerRequired } from "./members.errors";
import {
  ensureOwnerLock,
  keepAnOwner,
  serialiseOwners,
  stillManager,
} from "./members.integrity";

type MembersAuth = Pick<Auth, "accounts" | "membership">;

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: Role | null;
  conflict: boolean;
  active: boolean;
  isViewer: boolean;
}

// The members of ONE organisation, for one request of a member (the resolver
// checked the permission). A member is a janus account holding a role in the
// organisation (src/core/auth/membership/); inviting one is the invitations
// module's.
//
// The last-owner rule: every change that may take an owner away (a demotion or
// a removal, oneself included) runs in a transaction that raises the
// organisation's lock document first (members.integrity.ts), so two at once
// conflict there and the loser, run again by `retryWriteConflicts` on the
// OUTERMOST transaction, reads the holders after the winner committed.
export class MembersService {
  constructor(
    private readonly core: CoreMongo,
    private readonly auth: MembersAuth,
    private readonly organisation: Organisation,
    private readonly viewerId: string,
  ) {}

  private get organisationId() {
    return this.organisation._id.toHexString();
  }

  private view(
    account: { id: string; name: string; email: string; active: boolean },
    roles: readonly Role[],
  ): MemberView {
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      role: roles.length === 1 ? (roles[0] ?? null) : null,
      conflict: roles.length > 1,
      active: account.active,
      isViewer: account.id === this.viewerId,
    };
  }

  // By name. An account holding several roles is listed with `conflict` and
  // no role.
  async list(): Promise<MemberView[]> {
    const held = await this.auth.membership.membersOf(this.organisationId);
    const roles = new Map(
      held.map(({ accountId, roles }) => [accountId, roles]),
    );
    const accounts = await this.auth.accounts.user.findMany([...roles.keys()]);
    return accounts
      .flatMap((account) => {
        const mine = roles.get(account.id);
        return mine ? [this.view(account, mine)] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  // Runs `change` serialised with every other change of the organisation's
  // members, once the ACTING viewer is checked again and the target's roles are
  // read under the lock: 404 for an account that holds no role. `change` is
  // safe to run twice (janus's writes are idempotent), and janus's writes come
  // last, so a conflict is met before any of them.
  private serialised<T>(
    accountId: string,
    change: (current: readonly Role[], actor: Role) => Promise<T>,
  ): Promise<T> {
    return retryWriteConflicts(async () => {
      await ensureOwnerLock(this.core, this.organisationId);
      return this.core.transaction(async (tx) => {
        await serialiseOwners(tx, this.organisationId);
        const actor = await stillManager(
          this.auth,
          this.organisationId,
          this.viewerId,
        );
        const current = await this.auth.membership.rolesOf(
          this.organisationId,
          accountId,
        );
        if (current.length === 0) throw memberNotFound();
        return change(current, actor);
      });
    }, exhausted);
  }

  // Whether the account is a REAL owner now: its one role is owner.
  private static isOwner(current: readonly Role[]) {
    return current.length === 1 && current[0] === "owner";
  }

  // Gives the member `role` (their one role there; `assign` revokes any other,
  // which repairs an account in conflict). The same single role is a no-op.
  async changeRole(accountId: string, role: Role): Promise<MemberView> {
    await this.serialised(accountId, async (current, actor) => {
      if (current.length === 1 && current[0] === role) return;
      const touchesOwner = role === "owner" || current.includes("owner");
      if (touchesOwner && actor !== "owner") throw ownerRequired();
      if (MembersService.isOwner(current) && role !== "owner") {
        await keepAnOwner(this.auth, this.organisationId, accountId);
      }
      await this.auth.membership.assign(this.organisationId, accountId, role);
    });
    return this.found(accountId);
  }

  // Takes the member out of the organisation, whatever roles they hold;
  // answers their id.
  async remove(accountId: string): Promise<string> {
    await this.serialised(accountId, async (current, actor) => {
      if (current.includes("owner") && actor !== "owner") throw ownerRequired();
      if (MembersService.isOwner(current)) {
        await keepAnOwner(this.auth, this.organisationId, accountId);
      }
      await this.auth.membership.remove(this.organisationId, accountId);
    });
    return accountId;
  }

  // The member as the API shows them, after a change.
  private async found(accountId: string): Promise<MemberView> {
    const [account, roles] = await Promise.all([
      this.auth.accounts.user.find(accountId),
      this.auth.membership.rolesOf(this.organisationId, accountId),
    ]);
    if (!account || roles.length === 0) throw memberNotFound();
    return this.view(account, roles);
  }
}

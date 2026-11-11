import { isObjectIdString, toObjectId } from "@softistx/mongo";
import { z } from "zod";
import type { CoreMongo } from "../../config/db";
import type { Locale } from "../../i18n/locale";
import type { Role } from "../access";
import type { Auth } from "../auth";
import { ownerRequired } from "../members/members.errors";
import { exhausted, invalid } from "../shared/errors";
import { retryWriteConflicts } from "../shared/locked";
import type { Organisation } from "../tenancy";
import {
  addressAlreadyMember,
  invitationNotFound,
  notPending,
} from "./invitations.errors";
import {
  type InvitationDocument,
  issueInvitation,
  sendInvitation,
} from "./invitations.issue";
import { invitationToken, lifespan } from "./invitations.token";

type Status = InvitationDocument["status"];

// The invitations of ONE organisation, for one request of a member who manages
// members (the resolver checked `member:manage`): invite, list, resend, revoke.
// `core` carries the inviter as actor, which stamps every write. Acceptance is
// invitations.acceptance.ts.
export class InvitationsService {
  constructor(
    private readonly core: CoreMongo,
    private readonly auth: Pick<
      Auth,
      "accounts" | "membership" | "clock" | "mailer" | "from" | "links"
    >,
    private readonly organisation: Organisation,
    // The role the inviter holds here: only an owner invites an owner.
    private readonly inviterRole: Role,
    // The language of the mails: the inviter's request.
    private readonly locale: Locale,
  ) {}

  private get organisationId() {
    return this.organisation._id;
  }

  // The address holds an account that is a member already: inviting it would
  // fail at its acceptance, so it is refused now.
  private async refuseMember(email: string) {
    const account = await this.auth.accounts.user.findByEmail(email);
    if (
      account &&
      (
        await this.auth.membership.rolesOf(
          this.organisationId.toHexString(),
          account.id,
        )
      ).length > 0
    ) {
      throw addressAlreadyMember();
    }
  }

  // Invites `email` (any case) with `role`: the address's pending invitation
  // is replaced.
  async invite(input: { email: string; name: string; role: Role }) {
    const email = input.email.trim().toLowerCase();
    // The model would refuse it with a raw ZodError (a 500).
    if (!z.email().safeParse(email).success) {
      throw invalid([{ path: "email", code: "validation.errors.invalid" }]);
    }
    if (input.role === "owner" && this.inviterRole !== "owner") {
      throw ownerRequired();
    }
    await this.refuseMember(email);
    const { invitation, token } = await retryWriteConflicts(
      () =>
        issueInvitation(
          { core: this.core, auth: this.auth },
          {
            organisationId: this.organisationId,
            email,
            name: input.name.trim(),
            role: input.role,
            locale: this.locale,
          },
        ),
      exhausted,
    );
    await sendInvitation(
      { auth: this.auth },
      invitation,
      token,
      this.organisation.name,
    );
    return invitation;
  }

  // The invitation of this organisation, PENDING; else 404 (none, or another
  // organisation's) or 409 (accepted or revoked).
  private async pending(id: string) {
    const invitation = isObjectIdString(id)
      ? await this.core.db.invitations.findFirst({
          _id: toObjectId(id),
          organisationId: this.organisationId,
        })
      : undefined;
    if (!invitation) throw invitationNotFound();
    if (invitation.status !== "PENDING") throw notPending();
    return invitation;
  }

  // Revokes a pending invitation. A concurrent acceptance wins: the write
  // loses its version and reads again, and finds it no longer pending (409).
  revoke(id: string): Promise<InvitationDocument> {
    return this.retried(async () => {
      const invitation = await this.pending(id);
      return this.core.db.invitations.update(invitation._id, {
        status: "REVOKED",
        version: invitation.version,
      });
    });
  }

  // A new token, valid 7 days from now, mailed to the address: the old link
  // ends. Refused once the address became a member.
  async resend(id: string) {
    const first = await this.pending(id);
    await this.refuseMember(first.email);
    const { resent, token } = await this.retried(async () => {
      const invitation = await this.pending(id);
      const fresh = invitationToken();
      const updated = await this.core.db.invitations.update(invitation._id, {
        tokenHash: fresh.tokenHash,
        expiresAt: new Date(this.auth.clock.now().getTime() + lifespan),
        version: invitation.version,
      });
      return { resent: updated, token: fresh.token };
    });
    await sendInvitation(
      { auth: this.auth },
      resent,
      token,
      this.organisation.name,
    );
    return resent;
  }

  // Runs a write that locks on the version it read again when it lost.
  private retried<T>(write: () => Promise<T>) {
    return retryWriteConflicts(write, exhausted, {
      beaten: (error) =>
        error instanceof Error && error.name === "OptimisticLockError",
    });
  }

  // Newest first, at most 100.
  list(status?: Status | null) {
    return this.core.db.invitations.findMany({
      filter: {
        organisationId: this.organisationId,
        ...(status && { status }),
      },
      sort: { _id: -1 },
      limit: 100,
    });
  }
}

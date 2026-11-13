import { JanusError } from "@softistx/janus";
import { OptimisticLockError } from "@softistx/mongo";
import type { CoreMongo } from "../../config/db";
import type { Locale } from "../../i18n/locale";
import { authCall, type SignInResult, signedIn } from "../accounts";
import type { Auth } from "../auth";
import {
  alreadyMember,
  invalidInvitation,
  passwordRequired,
} from "./invitations.errors";
import type { InvitationDocument } from "./invitations.issue";
import { sha256 } from "./invitations.token";

// What `acceptInvitation` answers: the sign-in of a proven e-mail, or `linked`
// when the invitation only added the membership to an account that signs in as
// usual.
export interface AcceptedInvitation {
  linked: boolean;
  signIn: SignInResult | null;
}

const linked: AcceptedInvitation = { linked: true, signIn: null };

// The account the invitation names must be the invitation's own: active, and
// holding the address the invitation was sent to; else nothing is written.
function checkAccount(
  account: { active: boolean; email: string },
  invitationEmail: string,
) {
  const same =
    account.email.trim().toLowerCase() === invitationEmail.trim().toLowerCase();
  if (!account.active || !same) throw invalidInvitation();
}

// The account vanished, was deactivated or changed between the find and a
// write: the invitation is no longer one to accept. Other refusals keep their
// answer.
function goneAsInvalid(error: unknown): never {
  if (
    error instanceof JanusError &&
    ["NOT_FOUND", "USER_INACTIVE", "VERSION_CONFLICT", "LOGIN_TAKEN"].includes(
      error.code,
    )
  ) {
    throw invalidInvitation();
  }
  throw error;
}

// Accepting an invitation of an organisation, from its mail's link: finds or
// makes the janus account of its e-mail, gives it the invitation's role in the
// organisation, and signs it in. `locale` is the accepting request's language,
// the language of a new account's mails.
export class AcceptanceService {
  constructor(
    private readonly core: CoreMongo,
    private readonly auth: Pick<Auth, "accounts" | "membership" | "clock">,
    private readonly locale: Locale,
    // Where a failure nobody can be told about goes (the app has no logger of
    // its own: the console, which the host collects).
    private readonly log: (
      message: string,
      error: unknown,
    ) => void = console.error,
  ) {}

  async accept(
    token: string,
    password: string | null | undefined,
  ): Promise<AcceptedInvitation> {
    const invitation = await this.core.db.invitations.findFirst({
      tokenHash: sha256(token),
    });
    const now = this.auth.clock.now();
    if (invitation?.status !== "PENDING" || invitation.expiresAt <= now) {
      throw invalidInvitation();
    }
    const organisation = await this.core.db.organisations.findById(
      invitation.organisationId,
    );
    if (organisation?.status !== "active") throw invalidInvitation();
    return authCall(() =>
      this.asUser(invitation, password).catch(goneAsInvalid),
    );
  }

  // The refusals come BEFORE any write to janus: an account that is not the
  // invitation's (deactivated, another address), one that already holds a role
  // in the organisation (409), or a new account with no password. Then an
  // account whose e-mail was never proved is proved now, by the invitation's
  // token, through janus's `proveFirst` (the password and the sessions someone
  // set without holding the inbox are dropped, and the invitation's password
  // becomes the account's). An account that already signs in (a proved e-mail
  // and a password) keeps it: the invitation only adds the membership, and the
  // answer is LINKED.
  private async asUser(
    invitation: InvitationDocument,
    password: string | null | undefined,
  ): Promise<AcceptedInvitation> {
    const users = this.auth.accounts.user;
    const email = invitation.email;
    const organisationId = invitation.organisationId.toHexString();
    const existing = await users.findByEmail(email);
    if (existing) {
      checkAccount(existing, email);
      // `rolesOf`, not `roleOf`: an account holding two roles is a member
      // too (`roleOf` answers null for it), and is not silently repaired.
      if (
        (await this.auth.membership.rolesOf(organisationId, existing.id))
          .length > 0
      ) {
        throw alreadyMember();
      }
      if (existing.emailVerified && existing.hasPassword) {
        await this.join(invitation, existing.id);
        return linked;
      }
    }
    if (!password) throw passwordRequired();
    // `findOrCreate` runs `input` only when nobody holds the login; the
    // password stays out of the fields, `proveFirst` would drop it.
    const { user: found } = await users.findOrCreate(email, () => ({
      email,
      name: invitation.name,
      locale: this.locale,
    }));
    checkAccount(found, email);
    const { user: proved } = await users.verifyEmail.proveFirst(found);
    const account = await users.setPassword(proved, password);
    await this.join(invitation, account.id);
    return this.provenSignIn(users.signInProven(account));
  }

  // The sign-in of a proven e-mail, after the invitation was accepted and the
  // membership granted: a refusal here (the account deactivated meanwhile)
  // leaves the acceptance done, so it answers `linked` and the person signs in
  // as usual. An outage (STORE_FAILED) stays an outage.
  private async provenSignIn(
    answer:
      | Parameters<typeof signedIn>[0]
      | Promise<Parameters<typeof signedIn>[0]>,
  ): Promise<AcceptedInvitation> {
    try {
      return { linked: false, signIn: signedIn(await answer) };
    } catch (error) {
      if (error instanceof JanusError && error.code !== "STORE_FAILED") {
        return linked;
      }
      throw error;
    }
  }

  // CLAIMS the invitation first (PENDING to ACCEPTED, under the optimistic
  // lock, so one acceptance wins and a revoke or a resend that landed since
  // the read makes the claim lose), THEN gives the role: a revoked invitation
  // grants no role (the janus writes of `asUser`, account, proof and password,
  // came before the claim, and stay). A grant that fails puts the invitation
  // back to PENDING (`release`), still usable, and rethrows.
  private async join(invitation: InvitationDocument, accountId: string) {
    const invitations = this.core.as(accountId).db.invitations;
    let claimed: InvitationDocument;
    try {
      claimed = await invitations.update(invitation._id, {
        status: "ACCEPTED",
        acceptedBy: accountId,
        version: invitation.version,
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) throw invalidInvitation();
      throw error;
    }
    try {
      await this.auth.membership.assign(
        invitation.organisationId.toHexString(),
        accountId,
        invitation.role,
      );
    } catch (error) {
      await this.release(claimed, accountId);
      throw error;
    }
  }

  // The compensation of a failed grant: the claimed invitation is PENDING
  // again. A failed put-back is tried once more (a dropped connection is
  // usually over by then), but never after an `OptimisticLockError`: that means
  // the invitation changed under us (revoked, or already put back), and a retry
  // would only overwrite it. Before logging, the invitation is read again: only
  // one still ACCEPTED is stuck (no role, its link spent, an admin issues a
  // fresh invitation); one already PENDING or revoked needs nothing. The
  // grant's error is the one thrown either way.
  private async release(claimed: InvitationDocument, accountId: string) {
    const invitations = this.core.as(accountId).db.invitations;
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await invitations.update(claimed._id, {
          status: "PENDING",
          acceptedBy: null,
          version: claimed.version,
        });
        return;
      } catch (error) {
        failure = error;
        if (error instanceof OptimisticLockError) break;
      }
    }
    try {
      const current = await invitations.findById(claimed._id);
      if (current && current.status !== "ACCEPTED") return;
    } catch {
      // Unreadable: treat it as stuck and log.
    }
    this.log(
      `invitation ${claimed._id.toHexString()}: could not put it back to PENDING after a failed grant (its link is spent; issue a fresh invitation)`,
      failure,
    );
  }
}

import type { ReadDocumentOf } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { CoreMongo } from "../../config/db";
import type { Locale } from "../../i18n/locale";
import type { Role } from "../access";
import type { Auth } from "../auth";
import { invitationMail } from "./invitations.mail";
import type { invitations } from "./invitations.model";
import { invitationToken, lifespan } from "./invitations.token";

export type InvitationDocument = ReadDocumentOf<typeof invitations>;

export interface IssueInput {
  organisationId: ObjectId;
  email: string;
  name: string;
  role: Role;
  locale: Locale;
}

// Makes an invitation: the address's pending ones in the organisation are
// revoked and the new one stored in ONE transaction (and the partial unique
// index `invitations_one_pending` backs it), so two at once never leave two
// pending; it is NOT mailed (`sendInvitation`), so a caller may mail it after
// its own transaction committed. `core` carries the actor that stamps it (an
// admin's account, or SYSTEM_ACTOR for the operator's CLI). It never retries: the caller wraps its
// OUTERMOST transaction in `retryWriteConflicts` (`core/shared/locked`), and the
// token is made inside, so each attempt gets a fresh one.
export async function issueInvitation(
  deps: { core: CoreMongo; auth: Pick<Auth, "clock"> },
  input: IssueInput,
) {
  const email = input.email.trim().toLowerCase();
  return deps.core.transaction(async (tx) => {
    await tx.db.invitations.updateMany(
      { organisationId: input.organisationId, email, status: "PENDING" },
      { $set: { status: "REVOKED" } },
    );
    const { token, tokenHash } = invitationToken();
    const invitation = await tx.db.invitations.create({
      organisationId: input.organisationId,
      email,
      name: input.name,
      role: input.role,
      locale: input.locale,
      tokenHash,
      expiresAt: new Date(deps.auth.clock.now().getTime() + lifespan),
      status: "PENDING",
    });
    return { invitation, token };
  });
}

// The mail, in the invitation's language.
export async function sendInvitation(
  deps: { auth: Pick<Auth, "mailer" | "from" | "links"> },
  invitation: InvitationDocument,
  token: string,
  organisationName: string,
) {
  await deps.auth.mailer.send({
    to: { name: invitation.name, address: invitation.email },
    from: deps.auth.from,
    ...invitationMail({
      locale: invitation.locale,
      name: invitation.name,
      organisation: organisationName,
      role: invitation.role,
      link: deps.auth.links.invitation(token),
      expiresAt: invitation.expiresAt,
    }),
  });
}

// Whether the address holds an account that is a member of the organisation
// already: inviting it would fail at its acceptance.
export async function isMemberAddress(
  deps: { auth: Pick<Auth, "accounts" | "membership"> },
  organisationId: ObjectId,
  email: string,
) {
  const account = await deps.auth.accounts.user.findByEmail(email);
  if (!account) return false;
  const roles = await deps.auth.membership.rolesOf(
    organisationId.toHexString(),
    account.id,
  );
  return roles.length > 0;
}

import { defineCodes } from "../../i18n/define-codes";
import { fail, invalid } from "../shared/errors";

// The codes the module answers with (`<module>.errors.<slug>`): the inventory
// `ErrorCode` (src/i18n/codes.ts) gathers. CONTEXT.md lists them.
export const codes = defineCodes("invitations", [
  "invalid",
  "already-member",
  "address-already-member",
  "not-found",
  "not-pending",
]);

// Not valid, revoked, accepted, expired, or its organisation is gone: one
// answer for all, so a token tells nothing.
export const invalidInvitation = () =>
  fail("invitations.errors.invalid", { status: 400 });

// A new account needs a password to be made.
export const passwordRequired = () =>
  invalid([{ path: "password", code: "validation.errors.required" }]);

// The account already holds a role in the organisation.
export const alreadyMember = () =>
  fail("invitations.errors.already-member", { status: 409 });

// The inviter's side: the address holds an account that is a member already
// (invite and resend). The invitee gets `alreadyMember` on acceptance.
export const addressAlreadyMember = () =>
  fail("invitations.errors.address-already-member", { status: 409 });

// resendInvitation and revokeInvitation: the id names no invitation of the
// organisation.
export const invitationNotFound = () =>
  fail("invitations.errors.not-found", { status: 404 });

// Resending or revoking an invitation that was accepted or revoked.
export const notPending = () =>
  fail("invitations.errors.not-pending", { status: 409 });

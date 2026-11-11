import type { Session } from "@softistx/janus";
import { type Viewer, viewerOf } from "../auth/viewer";

export type Account = Parameters<typeof viewerOf>[0];

// An open session as the API answers it (`Session`): the token for the BFF,
// when it ends, and the account.
export interface SessionPayload {
  token: string;
  expiresAt: Date;
  viewer: Viewer;
}

// What a sign-in answers (`SignInResult`): a session, or the challenge of the
// second factor.
export type SignInResult =
  | { status: "SIGNED_IN"; session: SessionPayload; challenge: null }
  | {
      status: "SECOND_FACTOR_REQUIRED";
      session: null;
      challenge: { token: string; expiresAt: Date };
    };

export const sessionOf = (opened: {
  user: Account;
  session: Session;
  token: string;
}): SessionPayload => ({
  token: opened.token,
  expiresAt: opened.session.expiresAt,
  viewer: viewerOf(opened.user, opened.session),
});

// janus's answer to a sign-in (`signIn`, a magic link, `signInProven`): a
// session, or a challenge when the account's second factor is active.
export function signedIn(
  answer:
    | { status: "signedIn"; user: Account; session: Session; token: string }
    | { status: "secondFactor"; challenge: string; expiresAt: Date },
): SignInResult {
  return answer.status === "signedIn"
    ? { status: "SIGNED_IN", session: sessionOf(answer), challenge: null }
    : {
        status: "SECOND_FACTOR_REQUIRED",
        session: null,
        challenge: { token: answer.challenge, expiresAt: answer.expiresAt },
      };
}

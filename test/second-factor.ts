import { expect } from "bun:test";
import { type AuthApp, proveEmail, specPassword, uniqueEmail } from "~/auth";

export const SignUp = `mutation($input: SignUpInput!) {
  signUp(input: $input) { session { token viewer { id hasSecondFactor } } }
}`;
export const SignIn = `mutation($input: SignInInput!) {
  signIn(input: $input) {
    status
    session { token viewer { hasSecondFactor } }
    challenge { token expiresAt }
  }
}`;
export const Confirm = `mutation($challenge: String!, $code: String!) {
  confirmSecondFactor(challenge: $challenge, code: $code) {
    status session { token viewer { id hasSecondFactor } }
  }
}`;
export const Recover = `mutation($challenge: String!, $recoveryCode: String!) {
  recoverSecondFactor(challenge: $challenge, recoveryCode: $recoveryCode) { status session { token } }
}`;

// An account with an ACTIVE second factor: its e-mail, secret and recovery codes.
export async function accountWithSecondFactor(kit: AuthApp) {
  const email = uniqueEmail("totp");
  const input = { email, password: specPassword, name: "Totp Person" };
  const signedUp = await kit
    .client()
    .call<{ signUp: { session: { token: string } } }>(SignUp, { input });
  await proveEmail(kit, email);
  const asAccount = kit.client(signedUp.signUp.session.token);
  const enrolment = await asAccount.call<{
    enrollSecondFactor: { secret: string; uri: string };
  }>(`mutation { enrollSecondFactor { secret uri } }`);
  const { secret, uri } = enrolment.enrollSecondFactor;
  expect(uri).toStartWith("otpauth://totp/pulsarix:");
  // Before activation nothing is asked at sign-in.
  const early = await kit
    .client()
    .call<{ signIn: { status: string } }>(SignIn, {
      input: { email, password: specPassword },
    });
  expect(early.signIn.status).toBe("SIGNED_IN");
  const activated = await asAccount.call<{
    activateSecondFactor: { codes: string[] };
  }>(
    `mutation($code: String!) { activateSecondFactor(code: $code) { codes } }`,
    { code: kit.code(secret) },
  );
  return {
    email,
    secret,
    input: { email, password: specPassword },
    recoveryCodes: activated.activateSecondFactor.codes,
    token: signedUp.signUp.session.token,
  };
}

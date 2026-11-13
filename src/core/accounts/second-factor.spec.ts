import { describe, expect, test } from "bun:test";
import { authApp, proveEmail, specPassword, uniqueEmail } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

const SignUp = `mutation($input: SignUpInput!) {
  signUp(input: $input) { session { token viewer { id hasSecondFactor } } }
}`;
const SignIn = `mutation($input: SignInInput!) {
  signIn(input: $input) {
    status
    session { token viewer { hasSecondFactor } }
    challenge { token expiresAt }
  }
}`;
const Confirm = `mutation($challenge: String!, $code: String!) {
  confirmSecondFactor(challenge: $challenge, code: $code) {
    status session { token viewer { id hasSecondFactor } }
  }
}`;
const Recover = `mutation($challenge: String!, $recoveryCode: String!) {
  recoverSecondFactor(challenge: $challenge, recoveryCode: $recoveryCode) { status session { token } }
}`;

// An account with an ACTIVE second factor: its e-mail, secret and recovery codes.
async function accountWithSecondFactor() {
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

describe("the TOTP second factor", () => {
  test("it is set up after the e-mail is proved, not before", async () => {
    const email = uniqueEmail("unproved");
    const created = await kit.client().call<{
      signUp: { session: { token: string } };
    }>(SignUp, {
      input: { email, password: specPassword, name: "Unproved Person" },
    });
    const me = kit.client(created.signUp.session.token);
    const refused = await me.attempt(
      `mutation { enrollSecondFactor { secret } }`,
    );
    expect(codeOf(refused)).toBe("auth.errors.email-unverified");
    expect(
      codeOf(
        await me.attempt(
          `mutation { activateSecondFactor(code: "123456") { codes } }`,
        ),
      ),
    ).toBe("auth.errors.email-unverified");
    await proveEmail(kit, email);
    const enrolled = await me.call<{ enrollSecondFactor: { secret: string } }>(
      `mutation { enrollSecondFactor { secret } }`,
    );
    expect(enrolled.enrollSecondFactor.secret).toBeTruthy();
  });

  test("a sign-in asks for a code, and the right code opens the session", async () => {
    const account = await accountWithSecondFactor();
    expect(account.recoveryCodes).toHaveLength(10);
    const asked = await kit.client().call<{
      signIn: {
        status: string;
        session: unknown;
        challenge: { token: string };
      };
    }>(SignIn, { input: account.input });
    expect(asked.signIn.status).toBe("SECOND_FACTOR_REQUIRED");
    expect(asked.signIn.session).toBeNull();

    // A wrong code is refused, with the tries left.
    const wrong = await kit.client().attempt(Confirm, {
      challenge: asked.signIn.challenge.token,
      code: "000000",
    });
    expect(codeOf(wrong)).toBe("auth.errors.invalid-code");
    expect(wrong.errors?.[0]?.extensions?.params?.["attemptsLeft"]).toBe(4);

    const opened = await kit.client().call<{
      confirmSecondFactor: {
        status: string;
        session: { token: string; viewer: { hasSecondFactor: boolean } };
      };
    }>(Confirm, {
      challenge: asked.signIn.challenge.token,
      code: kit.nextCode(account.secret),
    });
    expect(opened.confirmSecondFactor.status).toBe("SIGNED_IN");
    expect(opened.confirmSecondFactor.session.viewer.hasSecondFactor).toBe(
      true,
    );
    // The session works.
    const viewer = await kit
      .client(opened.confirmSecondFactor.session.token)
      .call<{ viewer: { email: string } }>(`{ viewer { email } }`);
    expect(viewer.viewer.email).toBe(account.email);

    // The challenge is spent.
    expect(
      codeOf(
        await kit.client().attempt(Confirm, {
          challenge: asked.signIn.challenge.token,
          code: kit.nextCode(account.secret),
        }),
      ),
    ).toBe("auth.errors.invalid-token");
  });

  test("a recovery code replaces the app once", async () => {
    const account = await accountWithSecondFactor();
    const [recovery] = account.recoveryCodes;
    const first = await kit
      .client()
      .call<{ signIn: { challenge: { token: string } } }>(SignIn, {
        input: account.input,
      });
    const opened = await kit
      .client()
      .call<{ recoverSecondFactor: { status: string } }>(Recover, {
        challenge: first.signIn.challenge.token,
        recoveryCode: recovery,
      });
    expect(opened.recoverSecondFactor.status).toBe("SIGNED_IN");
    const second = await kit
      .client()
      .call<{ signIn: { challenge: { token: string } } }>(SignIn, {
        input: account.input,
      });
    expect(
      codeOf(
        await kit.client().attempt(Recover, {
          challenge: second.signIn.challenge.token,
          recoveryCode: recovery,
        }),
      ),
    ).toBe("auth.errors.invalid-code");
  });

  test("five wrong codes spend the challenge", async () => {
    const account = await accountWithSecondFactor();
    const asked = await kit
      .client()
      .call<{ signIn: { challenge: { token: string } } }>(SignIn, {
        input: account.input,
      });
    for (let i = 0; i < 5; i++) {
      await kit.client().attempt(Confirm, {
        challenge: asked.signIn.challenge.token,
        code: "000000",
      });
    }
    expect(
      codeOf(
        await kit.client().attempt(Confirm, {
          challenge: asked.signIn.challenge.token,
          code: kit.nextCode(account.secret),
        }),
      ),
    ).toBe("auth.errors.invalid-token");
  });

  test("activation needs an enrolment, and a second enrolment waits until the first is disabled", async () => {
    const email = uniqueEmail("totp");
    const signedUp = await kit
      .client()
      .call<{ signUp: { session: { token: string } } }>(SignUp, {
        input: { email, password: specPassword, name: "Person" },
      });
    await proveEmail(kit, email);
    const me = kit.client(signedUp.signUp.session.token);
    expect(
      codeOf(
        await me.attempt(
          `mutation { activateSecondFactor(code: "123456") { codes } }`,
        ),
      ),
    ).toBe("auth.errors.second-factor-not-enrolled");
    const { enrollSecondFactor } = await me.call<{
      enrollSecondFactor: { secret: string };
    }>(`mutation { enrollSecondFactor { secret } }`);
    expect(
      codeOf(
        await me.attempt(
          `mutation { activateSecondFactor(code: "000000") { codes } }`,
        ),
      ),
    ).toBe("auth.errors.invalid-code");
    await me.call(
      `mutation($code: String!) { activateSecondFactor(code: $code) { codes } }`,
      {
        code: kit.code(enrollSecondFactor.secret),
      },
    );
    expect(
      codeOf(await me.attempt(`mutation { enrollSecondFactor { secret } }`)),
    ).toBe("auth.errors.second-factor-active");
    // Disabling needs a recent proof of identity; the sign-in is recent.
    await me.call(`mutation { disableSecondFactor }`);
    const after = await kit
      .client()
      .call<{ signIn: { status: string } }>(SignIn, {
        input: { email, password: specPassword },
      });
    expect(after.signIn.status).toBe("SIGNED_IN");
  });

  test("enrolling asks for a recent proof", async () => {
    const email = uniqueEmail("totp");
    const signedUp = await kit
      .client()
      .call<{ signUp: { session: { token: string } } }>(SignUp, {
        input: { email, password: specPassword, name: "Person" },
      });
    await proveEmail(kit, email);
    kit.clock.advance(11 * 60 * 1000);
    expect(
      codeOf(
        await kit
          .client(signedUp.signUp.session.token)
          .attempt(`mutation { enrollSecondFactor { secret } }`),
      ),
    ).toBe("auth.errors.step-up-required");
  });

  test("disabling the factor asks for a recent proof", async () => {
    const account = await accountWithSecondFactor();
    kit.clock.advance(11 * 60 * 1000);
    expect(
      codeOf(
        await kit
          .client(account.token)
          .attempt(`mutation { disableSecondFactor }`),
      ),
    ).toBe("auth.errors.step-up-required");
  });
});

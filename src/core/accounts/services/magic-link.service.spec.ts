import { describe, expect, test } from "bun:test";
import {
  authApp,
  signedUp,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { codeOf } from "~/http";

const off = authApp();
const on = authApp({ magicLink: true });

const Request = `mutation($e: String!) { requestMagicLink(email: $e) }`;
const Confirm = `mutation($t: String!) {
  confirmMagicLink(token: $t) { status session { token } challenge { token } }
}`;
const Config = `{ authConfig { magicLink } }`;

describe("sign-in by link, flag off (the default)", () => {
  test("the public config says it is off", async () => {
    expect(await off.client().call<unknown>(Config)).toEqual({
      authConfig: { magicLink: false },
    });
  });

  test("a request is answered true for any address and sends nothing", async () => {
    const account = await signedUp(off);
    const before = off.outbox.sent.length;
    for (const email of [account.email, uniqueEmail("ghost")]) {
      expect(await off.client().call<unknown>(Request, { e: email })).toEqual({
        requestMagicLink: true,
      });
    }
    await off.settled();
    expect(off.outbox.sent.length).toBe(before);
  });

  test("a confirmation is refused as unavailable, even with a real token", async () => {
    const account = await signedUp(on);
    await on.client().call<unknown>(Request, { e: account.email });
    await on.settled();
    const token = tokenSent(on, account.email, "magicLink");
    // The same janus store, flag off: the token is never spent.
    const refused = await off.client().attempt(Confirm, { t: token });
    expect(codeOf(refused)).toBe("auth.errors.unavailable");
  });
});

describe("sign-in by link, flag on", () => {
  test("the public config says it is on, to an anonymous client", async () => {
    expect(await on.client().call<unknown>(Config)).toEqual({
      authConfig: { magicLink: true },
    });
  });

  test("a member with a second factor gets the challenge, not a session", async () => {
    const email = uniqueEmail("totp-link");
    // A link proves an unproved e-mail for the first time and drops the
    // second factor (janus), so the account proves its e-mail by a link first.
    await on
      .client()
      .call(
        `mutation($input: SignUpInput!) { signUp(input: $input) { status } }`,
        { input: { email, password: specPassword, name: "Totp Person" } },
      );
    await on.client().call<unknown>(Request, { e: email });
    await on.settled();
    const first = await on.client().call<{
      confirmMagicLink: { session: { token: string } };
    }>(Confirm, { t: tokenSent(on, email, "magicLink") });
    const me = on.client(first.confirmMagicLink.session.token);
    const { enrollSecondFactor } = await me.call<{
      enrollSecondFactor: { secret: string };
    }>(`mutation { enrollSecondFactor { secret } }`);
    await me.call(
      `mutation($c: String!) { activateSecondFactor(code: $c) { codes } }`,
      { c: on.code(enrollSecondFactor.secret) },
    );

    await on.client().call<unknown>(Request, { e: email });
    await on.settled();
    const token = tokenSent(on, email, "magicLink");
    const opened = await on.client().call<{
      confirmMagicLink: {
        status: string;
        session: unknown;
        challenge: { token: string };
      };
    }>(Confirm, { t: token });
    expect(opened.confirmMagicLink.status).toBe("SECOND_FACTOR_REQUIRED");
    expect(opened.confirmMagicLink.session).toBeNull();

    const done = await on.client().call<{
      confirmSecondFactor: { status: string; session: { token: string } };
    }>(
      `mutation($ch: String!, $c: String!) {
        confirmSecondFactor(challenge: $ch, code: $c) { status session { token } }
      }`,
      {
        ch: opened.confirmMagicLink.challenge.token,
        c: on.nextCode(enrollSecondFactor.secret),
      },
    );
    expect(done.confirmSecondFactor.status).toBe("SIGNED_IN");
    expect(done.confirmSecondFactor.session.token).toBeTruthy();
  });

  test("a known and an unknown address get the same answer", async () => {
    const account = await signedUp(on);
    const known = await on
      .client()
      .attempt<unknown>(Request, { e: account.email });
    const unknown = await on
      .client()
      .attempt(Request, { e: uniqueEmail("nobody") });
    expect(known).toEqual(unknown);
    expect(known.data).toEqual({ requestMagicLink: true });
  });

  test("requests for one address are throttled (429), known or not", async () => {
    const account = await signedUp(on);
    for (const email of [account.email, uniqueEmail("nobody")]) {
      let last: Awaited<ReturnType<ReturnType<typeof on.client>["attempt"]>> =
        {};
      for (let i = 0; i < 6; i++) {
        last = await on.client().attempt(Request, { e: email });
      }
      expect(codeOf(last)).toBe("auth.errors.too-many-attempts");
      expect(
        last.errors?.[0]?.extensions?.params?.["retryAfter"],
      ).toBeGreaterThan(0);
    }
  });
});

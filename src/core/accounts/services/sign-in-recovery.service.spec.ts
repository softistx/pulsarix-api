import { describe, expect, test } from "bun:test";
import {
  authApp,
  signedUp,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { codeOf } from "~/http";
import { SignIn } from "~/sign-in";

const kit = authApp({ magicLink: true });

describe("magic link, reset and password change", () => {
  test("a sign-in link opens a session, once", async () => {
    const account = await signedUp(kit);
    expect(
      await kit
        .client()
        .call<{ requestMagicLink: boolean }>(
          `mutation($e: String!) { requestMagicLink(email: $e) }`,
          { e: account.email },
        ),
    ).toEqual({
      requestMagicLink: true,
    });
    await kit.settled();
    const token = tokenSent(kit, account.email, "magicLink");
    const opened = await kit.client().call<{
      confirmMagicLink: {
        status: string;
        session: { viewer: { email: string } };
      };
    }>(
      `mutation($t: String!) { confirmMagicLink(token: $t) { status session { viewer { email } } } }`,
      { t: token },
    );
    expect(opened.confirmMagicLink.session.viewer.email).toBe(account.email);
    expect(
      codeOf(
        await kit
          .client()
          .attempt(
            `mutation($t: String!) { confirmMagicLink(token: $t) { status } }`,
            { t: token },
          ),
      ),
    ).toBe("auth.errors.invalid-token");
  });

  test("a request for an unknown address answers true and sends nothing", async () => {
    const before = kit.outbox.sent.length;
    const answer = await kit
      .client()
      .call<{ requestMagicLink: boolean }>(
        `mutation($e: String!) { requestMagicLink(email: $e) }`,
        { e: uniqueEmail("ghost") },
      );
    expect(answer).toEqual({ requestMagicLink: true });
    await kit.settled();
    expect(kit.outbox.sent.length).toBe(before);
  });

  test("a reset link sets a new password and signs the account out everywhere", async () => {
    const account = await signedUp(kit);
    await kit
      .client()
      .call(`mutation($e: String!) { requestPasswordReset(email: $e) }`, {
        e: account.email,
      });
    await kit.settled();
    const token = tokenSent(kit, account.email, "resetPassword");
    const short = await kit
      .client()
      .attempt(
        `mutation($t: String!, $p: String!) { resetPassword(token: $t, password: $p) }`,
        { t: token, p: "short" },
      );
    expect(short.errors?.[0]?.extensions?.fields?.[0]?.code).toBe(
      "validation.errors.too-short",
    );
    await kit
      .client()
      .call(
        `mutation($t: String!, $p: String!) { resetPassword(token: $t, password: $p) }`,
        {
          t: token,
          p: "another long password",
        },
      );
    expect(
      codeOf(await kit.client(account.token).attempt(`{ viewer { id } }`)),
    ).toBeUndefined();
    expect(
      (
        await kit
          .client(account.token)
          .call<{ viewer: unknown }>(`{ viewer { id } }`)
      ).viewer,
    ).toBeNull();
    const signedIn = await kit
      .client()
      .call<{ signIn: { status: string } }>(SignIn, {
        input: { email: account.email, password: "another long password" },
      });
    expect(signedIn.signIn.status).toBe("SIGNED_IN");
  });

  test("changing the password ends the other sessions and keeps this one", async () => {
    const account = await signedUp(kit);
    const other = await kit
      .client()
      .call<{ signIn: { session: { token: string } } }>(SignIn, {
        input: { email: account.email, password: specPassword },
      });
    const me = kit.client(account.token);
    kit.clock.advance(1000);
    const wrong = await me.attempt(
      `mutation { changePassword(input: { currentPassword: "nope nope", newPassword: "a brand new password" }) }`,
    );
    expect(wrong.errors?.[0]?.extensions?.fields?.[0]?.path).toBe(
      "currentPassword",
    );
    await me.call(
      `mutation($i: ChangePasswordInput!) { changePassword(input: $i) }`,
      {
        i: {
          currentPassword: specPassword,
          newPassword: "a brand new password",
        },
      },
    );
    expect(
      (await me.call<{ viewer: unknown }>(`{ viewer { id } }`)).viewer,
    ).not.toBeNull();
    expect(
      (
        await kit
          .client(other.signIn.session.token)
          .call<{ viewer: unknown }>(`{ viewer { id } }`)
      ).viewer,
    ).toBeNull();
  });

  test("signing out ends the session", async () => {
    const account = await signedUp(kit);
    const me = kit.client(account.token);
    expect(await me.call<{ signOut: boolean }>(`mutation { signOut }`)).toEqual(
      { signOut: true },
    );
    expect(
      (await me.call<{ viewer: unknown }>(`{ viewer { id } }`)).viewer,
    ).toBeNull();
  });
});

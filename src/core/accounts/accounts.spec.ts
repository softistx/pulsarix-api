import { describe, expect, test } from "bun:test";
import {
  authApp,
  signedUp,
  specPassword,
  tokenSent,
  uniqueEmail,
} from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

const SignIn = `mutation($input: SignInInput!) {
  signIn(input: $input) { status session { token viewer { email name language permissions } } }
}`;

describe("sign-up and sign-in", () => {
  test("sign-up opens a session whose viewer may create an organisation", async () => {
    const account = await signedUp(kit, "Ada Lovelace");
    const { viewer } = await kit.client(account.token).call<{
      viewer: {
        email: string;
        name: string;
        permissions: string[];
        hasSecondFactor: boolean;
      };
    }>(`{ viewer { email name permissions hasSecondFactor } }`);
    expect(viewer).toEqual({
      email: account.email,
      name: "Ada Lovelace",
      permissions: ["organisation:create"],
      hasSecondFactor: false,
    });
    expect(
      (await kit.client().call<{ viewer: unknown }>(`{ viewer { id } }`))
        .viewer,
    ).toBeNull();
  });

  test("an address that is taken, a short password and a missing client header are refused", async () => {
    const account = await signedUp(kit);
    const input = {
      email: account.email,
      password: specPassword,
      name: "Again",
    };
    const taken = await kit
      .client()
      .attempt(
        `mutation($input: SignUpInput!) { signUp(input: $input) { status } }`,
        { input },
      );
    expect(codeOf(taken)).toBe("validation.errors.invalid-input");
    expect(taken.errors?.[0]?.extensions?.fields?.[0]?.path).toBe("email");
    const short = await kit
      .client()
      .attempt(
        `mutation($input: SignUpInput!) { signUp(input: $input) { status } }`,
        {
          input: { ...input, email: uniqueEmail(), password: "short" },
        },
      );
    expect(short.errors?.[0]?.extensions?.fields?.[0]).toMatchObject({
      path: "password",
      code: "validation.errors.too-short",
    });
    const response = await kit.app.fetch(
      new Request("https://ui.pulsarix.test/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("a wrong password is one answer for a wrong or an unknown address", async () => {
    const account = await signedUp(kit);
    const wrong = await kit.client().attempt(SignIn, {
      input: { email: account.email, password: "not the password" },
    });
    const unknown = await kit.client().attempt(SignIn, {
      input: { email: uniqueEmail("nobody"), password: specPassword },
    });
    expect(codeOf(wrong)).toBe("auth.errors.invalid-credentials");
    expect(codeOf(unknown)).toBe("auth.errors.invalid-credentials");
    expect(wrong.errors?.[0]?.message).toBe(unknown.errors?.[0]?.message);
  });

  test("ten wrong passwords at one address are throttled (429)", async () => {
    const account = await signedUp(kit);
    let last:
      | Awaited<ReturnType<ReturnType<typeof kit.client>["attempt"]>>
      | undefined;
    for (let i = 0; i < 11; i++) {
      last = await kit.client().attempt(SignIn, {
        input: { email: account.email, password: "wrong wrong" },
      });
    }
    expect(codeOf(last ?? {})).toBe("auth.errors.too-many-attempts");
    expect(last?.errors?.[0]?.extensions?.http?.status).toBe(429);
  });

  test("the account's language and name are its own to change", async () => {
    const account = await signedUp(kit);
    const me = kit.client(account.token);
    const updated = await me.call<{
      updateViewer: { name: string; language: string };
    }>(
      `mutation { updateViewer(input: { name: "Ada K.", language: FR }) { name language } }`,
    );
    expect(updated.updateViewer).toEqual({ name: "Ada K.", language: "FR" });
    expect(
      codeOf(
        await me.attempt(
          `mutation { updateViewer(input: { name: null }) { name } }`,
        ),
      ),
    ).toBe("validation.errors.invalid-input");
  });
});

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

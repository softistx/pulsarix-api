import { describe, expect, test } from "bun:test";
import { authApp, signedUp, specPassword, uniqueEmail } from "~/auth";
import { codeOf } from "~/http";
import { SignIn } from "~/sign-in";

const kit = authApp({ magicLink: true });

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

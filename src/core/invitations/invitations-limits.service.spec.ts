import { describe, expect, spyOn, test } from "bun:test";
import { authApp, specPassword, uniqueEmail } from "~/auth";
import { codeOf } from "~/http";
import { Accept } from "~/invitations";
import { addressKey } from "../shared/address";

describe("the per-address limits of the anonymous mutations", () => {
  const limit = (allowed: () => boolean, keys: string[]) => ({
    consume: async (params: { ip: string }) => {
      keys.push(params.ip);
      return { allowed: allowed(), retryAfter: 90_000 };
    },
  });
  const unused = {
    organisationCreate: {
      consume: async () => ({ allowed: true, retryAfter: 0 }),
    },
  };

  test("sign-up and acceptInvitation are refused 429 past their limit", async () => {
    let open = true;
    const signUpKeys: string[] = [];
    const acceptKeys: string[] = [];
    const limited = authApp({
      limits: {
        ...unused,
        signUpIp: limit(() => open, signUpKeys),
        acceptInvitationIp: limit(() => open, acceptKeys),
      },
    });
    const SignUp = `mutation($input: SignUpInput!) {
      signUp(input: $input) { status }
    }`;
    const input = {
      email: uniqueEmail("limited"),
      password: specPassword,
      name: "Limited",
    };
    await limited.client().call(SignUp, { input });
    // Specs have no connection address: the key is addressKey(ctx.ip), and a
    // forged x-forwarded-for from an untrusted peer does not change it.
    expect(signUpKeys).toEqual([addressKey(undefined)]);
    await limited
      .client(null, {
        headers: { "x-forwarded-for": "198.51.100.1" },
      })
      .attempt(SignUp, {
        input: { ...input, email: uniqueEmail("forged") },
      });
    expect(signUpKeys).toEqual([addressKey(undefined), addressKey(undefined)]);
    open = false;
    expect(
      codeOf(
        await limited
          .client()
          .attempt(SignUp, { input: { ...input, email: uniqueEmail("l2") } }),
      ),
    ).toBe("auth.errors.too-many-attempts");
    expect(
      codeOf(
        await limited
          .client()
          .attempt(Accept, { token: "x", password: specPassword }),
      ),
    ).toBe("auth.errors.too-many-attempts");
    expect(acceptKeys).toEqual([addressKey(undefined)]);
  });

  test("a limiter that throws is a 503, never a free pass", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const down = {
        consume: async () => {
          throw new Error("redis down");
        },
      };
      const broken = authApp({
        limits: { ...unused, signUpIp: down, acceptInvitationIp: down },
      });
      const refused = await broken
        .client()
        .attempt(
          `mutation($input: SignUpInput!) { signUp(input: $input) { status } }`,
          {
            input: {
              email: uniqueEmail("down"),
              password: specPassword,
              name: "Down",
            },
          },
        );
      expect(codeOf(refused)).toBe("auth.errors.unavailable");
      expect(
        codeOf(
          await broken
            .client()
            .attempt(Accept, { token: "x", password: specPassword }),
        ),
      ).toBe("auth.errors.unavailable");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

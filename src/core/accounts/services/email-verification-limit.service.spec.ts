import { describe, expect, spyOn, test } from "bun:test";
import { authApp, proveEmail, signedUp } from "~/auth";
import { Request } from "~/email-verification";
import { codeOf } from "~/http";

describe("the account limit of requestEmailVerification", () => {
  const unused = {
    organisationCreate: {
      consume: async () => ({ allowed: true, retryAfter: 0 }),
    },
  };

  test("is refused 429 past the limit, proved or not", async () => {
    const keys: string[] = [];
    let open = true;
    const limited = authApp({
      limits: {
        ...unused,
        emailVerificationAccount: {
          consume: async (params: { accountId: string }) => {
            keys.push(params.accountId);
            return { allowed: open, retryAfter: 90_000 };
          },
        },
      },
    });
    const account = await signedUp(limited);
    const proved = await signedUp(limited);
    await proveEmail(limited, proved.email);
    await limited.client(account.token).call(Request);
    expect(keys).toEqual([account.id]);
    open = false;
    for (const who of [account, proved]) {
      const refused = await limited.client(who.token).attempt(Request);
      expect(codeOf(refused)).toBe("auth.errors.too-many-attempts");
      expect(refused.errors?.[0]?.extensions?.params?.["retryAfter"]).toBe(90);
    }
  });

  test("the account limit is spent before janus counts the address", async () => {
    let open = false;
    const limited = authApp({
      limits: {
        ...unused,
        emailVerificationAccount: {
          consume: async () => ({ allowed: open, retryAfter: 1_000 }),
        },
      },
    });
    const account = await signedUp(limited);
    // Six refusals by the limit: janus (5 per 10 minutes) counted none.
    for (let i = 0; i < 6; i++) {
      expect(codeOf(await limited.client(account.token).attempt(Request))).toBe(
        "auth.errors.too-many-attempts",
      );
    }
    open = true;
    await limited.client(account.token).call(Request);
    await limited.settled();
    expect(limited.sent.some((s) => s.to === account.email)).toBe(true);
  });

  test("a limiter that throws is a 503, never a free pass", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const broken = authApp({
        limits: {
          ...unused,
          emailVerificationAccount: {
            consume: async () => {
              throw new Error("redis down");
            },
          },
        },
      });
      const account = await signedUp(broken);
      const refused = await broken.client(account.token).attempt(Request);
      expect(codeOf(refused)).toBe("auth.errors.unavailable");
      await broken.settled();
      expect(broken.sent.some((s) => s.to === account.email)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { EmailUnverifiedError, TokenError } from "@softistx/janus";
import { fromJanus } from "./accounts.errors";

describe("fromJanus", () => {
  test("janus's EMAIL_UNVERIFIED is the API's 403 email-unverified, not a 500", () => {
    const answered = fromJanus(new EmailUnverifiedError("e-mail not verified"));
    expect(answered?.extensions["code"]).toBe("auth.errors.email-unverified");
    expect(answered?.extensions["http"]).toEqual({ status: 403 });
  });

  test("a throttled CODE_INVALID is too-many-attempts with its retryAfter", () => {
    const answered = fromJanus(
      new TokenError("CODE_INVALID", "throttled", {
        reason: "throttled",
        attemptsLeft: 0,
        retryAfter: 120,
      }),
    );
    expect(answered?.extensions["code"]).toBe("auth.errors.too-many-attempts");
    expect(JSON.stringify(answered?.extensions)).toContain("120");
  });

  test("a plain CODE_INVALID stays invalid-code with attemptsLeft", () => {
    const answered = fromJanus(
      new TokenError("CODE_INVALID", "wrong", { attemptsLeft: 3 }),
    );
    expect(answered?.extensions["code"]).toBe("auth.errors.invalid-code");
    expect(JSON.stringify(answered?.extensions)).toContain("3");
  });
});

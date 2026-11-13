import { describe, expect, test } from "bun:test";
import { EmailUnverifiedError } from "@softistx/janus";
import { fromJanus } from "./accounts.errors";

describe("fromJanus", () => {
  test("janus's EMAIL_UNVERIFIED is the API's 403 email-unverified, not a 500", () => {
    const answered = fromJanus(new EmailUnverifiedError("e-mail not verified"));
    expect(answered?.extensions["code"]).toBe("auth.errors.email-unverified");
    expect(answered?.extensions["http"]).toEqual({ status: 403 });
  });
});

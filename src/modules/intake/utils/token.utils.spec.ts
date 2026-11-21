import { describe, expect, test } from "bun:test";
import {
  emailDigest,
  hashSecret,
  newPublicKey,
  newTrackingToken,
  parseTrackingToken,
} from "./token.utils";

const ORGANISATION = "0123456789abcdef01234567";

describe("newPublicKey", () => {
  test("is pk_live_ and 192 random bits, never the same twice", () => {
    const key = newPublicKey();
    expect(key).toMatch(/^pk_live_[A-Za-z0-9_-]{32}$/);
    expect(newPublicKey()).not.toBe(key);
  });
});

describe("tracking tokens", () => {
  test("a new token parses back to its organisation and the stored hash", () => {
    const { token, hash } = newTrackingToken(ORGANISATION);
    expect(token.startsWith(`${ORGANISATION}.`)).toBe(true);
    expect(parseTrackingToken(token)).toEqual({
      organisationId: ORGANISATION,
      hash,
    });
    expect(hash).toBe(hashSecret(token.split(".")[1] ?? ""));
  });

  test("anything not spelled like a token is null", () => {
    const { token } = newTrackingToken(ORGANISATION);
    const secret = token.split(".")[1] ?? "";
    for (const bad of [
      "",
      "nope",
      `${ORGANISATION}.`,
      `.${secret}`,
      `${ORGANISATION}.short`,
      `${ORGANISATION}.${secret}.extra`,
      `ZZZ${ORGANISATION.slice(3)}.${secret}`,
      `${ORGANISATION.toUpperCase()}.${secret}`,
    ]) {
      expect(parseTrackingToken(bad)).toBeNull();
    }
  });
});

describe("emailDigest", () => {
  test("is a SHA-256 hex digest, the same for any case and spacing", () => {
    expect(emailDigest("A@x.test")).toMatch(/^[0-9a-f]{64}$/);
    expect(emailDigest(" A@X.test ")).toBe(emailDigest("a@x.test"));
    expect(emailDigest("b@x.test")).not.toBe(emailDigest("a@x.test"));
  });
});

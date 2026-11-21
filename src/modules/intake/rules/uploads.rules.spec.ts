import { describe, expect, test } from "bun:test";
import { checkAnnounced, essenceOf } from "./uploads.rules";

const claims = { type: "image/png", size: 100 } as Parameters<
  typeof checkAnnounced
>[0];

describe("essenceOf", () => {
  test("drops the parameters and lowers the case", () => {
    expect(essenceOf("Image/PNG; charset=x")).toBe("image/png");
    expect(essenceOf(null)).toBe("");
  });
});

describe("checkAnnounced", () => {
  test("the announced type and length are the ticket's, exactly", () => {
    expect(() =>
      checkAnnounced(claims, { contentType: "image/png", length: "100" }),
    ).not.toThrow();
  });

  test("another type, a missing, larger or smaller length is refused", () => {
    const refused = (contentType: string | null, length: string | null) =>
      expect(() => checkAnnounced(claims, { contentType, length })).toThrow();
    refused("image/jpeg", "100");
    refused("image/png", null);
    refused("image/png", "abc");
    refused("image/png", "101");
    refused("image/png", "99");
  });
});

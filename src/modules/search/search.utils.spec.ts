import { describe, expect, test } from "bun:test";
import { issueKeyOf } from "./search.utils";

describe("issueKeyOf", () => {
  test("an issue key is upper-cased, anything else is null", () => {
    expect(issueKeyOf("px-12")).toBe("PX-12");
    expect(issueKeyOf("fix the bug")).toBeNull();
    expect(issueKeyOf("px-")).toBeNull();
  });
});

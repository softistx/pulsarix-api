import { describe, expect, test } from "bun:test";
import { stripControl } from "./text.utils";

describe("stripControl", () => {
  test("drops control characters and DEL, keeps newline and tab", () => {
    expect(stripControl("a\u0000b\u001bc\u0007d\u007fe")).toBe("abcde");
    expect(stripControl("line 1\nline\t2")).toBe("line 1\nline\t2");
  });

  test("keeps accents, emoji and other text as written", () => {
    expect(stripControl("Élise 👍 日本")).toBe("Élise 👍 日本");
    expect(stripControl("")).toBe("");
  });

  test("a carriage return is a control character", () => {
    expect(stripControl("a\r\nb")).toBe("a\nb");
  });
});

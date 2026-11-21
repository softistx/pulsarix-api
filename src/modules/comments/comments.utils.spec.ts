import { describe, expect, test } from "bun:test";
import { mentionedIds } from "./comments.utils";

describe("mention markers", () => {
  test("distinct ids in order of appearance", () => {
    expect(
      mentionedIds("Hi @[Ada](a-1), @[Bob K.](b-2) and @[Ada again](a-1)!"),
    ).toEqual(["a-1", "b-2"]);
  });
  test("plain @ text and malformed markers name nobody", () => {
    expect(
      mentionedIds("mail me @ada, @[x] (y), @[x]() and @[a](b c)"),
    ).toEqual([]);
  });
});

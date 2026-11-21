import { describe, expect, test } from "bun:test";
import { after, type Cursor, decode, encode, lateOf } from "./dashboard.utils";

const id = "0123456789abcdef01234567";
const cursor: Cursor = [1, 3, 1700000000000, id, "2026-01-02"];

describe("cursor", () => {
  test("round-trips on the same day", () => {
    expect(decode(encode(cursor), "2026-01-02")).toEqual(cursor);
  });
  test("a cursor of another day is refused", () => {
    expect(() => decode(encode(cursor), "2026-01-03")).toThrow();
  });
  test("garbage and malformed cursors are refused", () => {
    expect(() => decode("!!", "2026-01-02")).toThrow();
    expect(() =>
      decode(encode([2, 3, 1, id, "2026-01-02"] as Cursor), "2026-01-02"),
    ).toThrow();
    expect(() =>
      decode(encode([1, 3, 1, "nope", "2026-01-02"] as Cursor), "2026-01-02"),
    ).toThrow();
  });
});

describe("after", () => {
  test("lists the four tie-break levels of the sort order", () => {
    expect(after(cursor).$or).toHaveLength(4);
  });
});

describe("lateOf", () => {
  test("counts a due date before the start only", () => {
    const expr = lateOf(new Date("2026-01-02T00:00:00Z"));
    expect(expr.$cond[1]).toBe(1);
    expect(expr.$cond[2]).toBe(0);
  });
});

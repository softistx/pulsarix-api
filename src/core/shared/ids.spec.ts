import { describe, expect, test } from "bun:test";
import { grouped } from "./ids";

describe("grouped", () => {
  test("answers each key in order, empty for a key with no row", () => {
    const rows = [
      { k: "b", n: 1 },
      { k: "a", n: 2 },
      { k: "b", n: 3 },
    ];
    expect(grouped(["a", "b", "c"], rows, (row) => row.k)).toEqual([
      [{ k: "a", n: 2 }],
      [
        { k: "b", n: 1 },
        { k: "b", n: 3 },
      ],
      [],
    ]);
  });

  test("ignores a row of no asked key", () => {
    expect(grouped(["a"], [{ k: "z" }], (row) => row.k)).toEqual([[]]);
  });
});

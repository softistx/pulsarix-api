import { describe, expect, test } from "bun:test";
import { firstRank, rankAfter, rankBetween } from "./rank";

describe("fractional ranks", () => {
  test("a column grows at its end, in order, and never ends in the zero digit", () => {
    const ranks = [firstRank];
    for (let i = 0; i < 200; i++) ranks.push(rankAfter(ranks.at(-1) ?? null));
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks.every((rank) => !rank.endsWith("0"))).toBe(true);
    // Counting up: a digit is added every 30 or so issues, not every one.
    expect(ranks.at(-1)?.length).toBeLessThan(8);
  });

  test("a rank fits between any two neighbours, however often it is halved", () => {
    let low = "V";
    const high = "W";
    for (let i = 0; i < 100; i++) {
      const mid = rankBetween(low, high);
      expect(mid).not.toBeNull();
      expect((mid as string) > low && (mid as string) < high).toBe(true);
      low = mid as string;
    }
    // And before the first.
    let first = firstRank;
    for (let i = 0; i < 100; i++) {
      const before = rankBetween(null, first) as string;
      expect(before < first).toBe(true);
      expect(before.endsWith("0")).toBe(false);
      first = before;
    }
  });

  test("neighbours out of order have no rank between them", () => {
    expect(rankBetween("W", "V")).toBeNull();
    expect(rankBetween("V", "V")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { datesIssues } from "./sprints.rules";

describe("sprint rules", () => {
  const a = new Date("2026-03-02T00:00:00Z");
  const b = new Date("2026-03-16T00:00:00Z");

  test("an end after the start, or a missing date, is fine", () => {
    expect(datesIssues(a, b)).toEqual([]);
    expect(datesIssues(a, a)).toEqual([]);
    expect(datesIssues(null, b)).toEqual([]);
    expect(datesIssues(a, null)).toEqual([]);
  });

  test("a sprint of eight weeks is fine, one day more is refused", () => {
    const eight = new Date("2026-04-27T00:00:00Z");
    const nine = new Date("2026-04-28T00:00:00Z");
    expect(datesIssues(a, eight)).toEqual([]);
    expect(datesIssues(a, nine)).toEqual([
      { path: "endDate", code: "validation.errors.invalid" },
    ]);
  });

  test("an end before the start is refused on endDate", () => {
    expect(datesIssues(b, a)).toEqual([
      { path: "endDate", code: "validation.errors.invalid" },
    ]);
  });
});

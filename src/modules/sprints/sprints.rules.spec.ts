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

  test("an end before the start is refused on endDate", () => {
    expect(datesIssues(b, a)).toEqual([
      { path: "endDate", code: "validation.errors.invalid" },
    ]);
  });
});

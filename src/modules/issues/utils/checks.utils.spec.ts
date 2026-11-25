import { describe, expect, test } from "bun:test";
import { bulkIssues, createIssues, updateIssues } from "./checks.utils";

const required = (path: string) => ({
  path,
  code: "validation.errors.required" as const,
});
const outOfRange = {
  path: "estimateHours",
  code: "validation.errors.out-of-range" as const,
};

describe("createIssues", () => {
  test("a blank title is required, a title is fine", () => {
    expect(createIssues({ projectId: "p", title: "  " })).toEqual([
      required("title"),
    ]);
    expect(createIssues({ projectId: "p", title: "Fix" })).toEqual([]);
  });

  test("an estimate out of range is refused once the title is there", () => {
    expect(
      createIssues({ projectId: "p", title: "Fix", estimateHours: -1 }),
    ).toEqual([outOfRange]);
  });
});

describe("updateIssues", () => {
  test("a null on a field that cannot be cleared is required", () => {
    expect(
      updateIssues({ title: null, priority: null, labelIds: null }),
    ).toEqual([required("title"), required("priority"), required("labelIds")]);
  });

  test("a blank title and a bad estimate are listed together", () => {
    expect(updateIssues({ title: " ", estimateHours: 100_001 })).toEqual([
      required("title"),
      outOfRange,
    ]);
  });

  test("an empty patch and a clearable null are fine", () => {
    expect(updateIssues({})).toEqual([]);
    expect(updateIssues({ assigneeId: null, estimateHours: null })).toEqual([]);
  });
});

describe("bulkIssues", () => {
  test("a patch that sets nothing is required on `input`", () => {
    expect(bulkIssues({})).toEqual([required("input")]);
  });

  test("a null status or priority is required, a bad estimate out of range", () => {
    expect(bulkIssues({ statusId: null, priority: null })).toEqual([
      required("statusId"),
      required("priority"),
    ]);
    expect(bulkIssues({ estimateHours: 200_000 })).toEqual([outOfRange]);
  });

  test("any single field makes a patch", () => {
    expect(bulkIssues({ dueDate: null })).toEqual([]);
    expect(bulkIssues({ addLabelIds: [] })).toEqual([]);
  });
});

describe("story points", () => {
  test("a value off the Fibonacci scale throws a 400 in every check", () => {
    const off = /Story points must be/;
    expect(() =>
      createIssues({ projectId: "p", title: "x", points: 4 }),
    ).toThrow(off);
    expect(() => updateIssues({ points: 0 })).toThrow(off);
    expect(() => bulkIssues({ points: 22 })).toThrow(off);
  });

  test("the scale and null pass, and points alone are a valid bulk patch", () => {
    for (const points of [1, 2, 3, 5, 8, 13, 21, null]) {
      expect(updateIssues({ points })).toEqual([]);
    }
    expect(bulkIssues({ points: 5 })).toEqual([]);
    expect(bulkIssues({ points: null })).toEqual([]);
  });
});

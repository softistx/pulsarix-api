import { describe, expect, test } from "bun:test";
import type { IssueType } from "./issues.model";
import {
  breaksChildren,
  parentRefusal,
  progressOf,
  rangeOf,
} from "./issues.rules";

describe("parentRefusal", () => {
  test("an Epic has no parent", () => {
    expect(parentRefusal("epic", null)).toBeNull();
    for (const parent of ["epic", "story", "task", "bug", "subTask"] as const) {
      expect(parentRefusal("epic", parent)).toBe("parent-not-allowed");
    }
  });

  test("a Story, a Task or a Bug may have an Epic as parent, or none", () => {
    for (const type of ["story", "task", "bug"] as const) {
      expect(parentRefusal(type, null)).toBeNull();
      expect(parentRefusal(type, "epic")).toBeNull();
      for (const parent of ["story", "task", "bug", "subTask"] as const) {
        expect(parentRefusal(type, parent)).toBe("parent-type-invalid");
      }
    }
  });

  test("a Sub-task must have a Story, a Task or a Bug as parent", () => {
    expect(parentRefusal("subTask", null)).toBe("parent-required");
    for (const parent of ["story", "task", "bug"] as const) {
      expect(parentRefusal("subTask", parent)).toBeNull();
    }
    for (const parent of ["epic", "subTask"] as const) {
      expect(parentRefusal("subTask", parent)).toBe("parent-type-invalid");
    }
  });
});

describe("breaksChildren", () => {
  test("an Epic with Story children cannot become a Story", () => {
    expect(breaksChildren("epic", "story", ["story"])).toBe(true);
    expect(breaksChildren("epic", "story", [])).toBe(false);
  });

  test("a Task with Sub-tasks cannot become an Epic or a Sub-task", () => {
    expect(breaksChildren("task", "epic", ["subTask"])).toBe(true);
    expect(breaksChildren("task", "subTask", ["subTask"])).toBe(true);
    expect(breaksChildren("task", "bug", ["subTask"])).toBe(false);
  });

  test("a link that already broke the rules is left alone", () => {
    const legacy: IssueType[] = ["task"];
    expect(breaksChildren("task", "bug", legacy)).toBe(false);
    expect(breaksChildren("task", "epic", legacy)).toBe(false);
  });
});

describe("progressOf", () => {
  const of = (categories: string[], points: (number | null)[] = []) =>
    categories.map((category, i) => ({ category, points: points[i] ?? null }));

  test("counts done children out of all, leaving the cancelled out", () => {
    expect(
      progressOf(of(["done", "todo", "cancelled", "done", "inProgress"])),
    ).toMatchObject({ done: 2, total: 4 });
    expect(progressOf([])).toEqual({
      done: 0,
      total: 0,
      points: 0,
      pointsDone: 0,
    });
    expect(progressOf(of(["cancelled"], [5]))).toMatchObject({
      total: 0,
      points: 0,
    });
  });

  test("sums the points of the children, and of the done ones", () => {
    expect(
      progressOf(of(["done", "todo", "cancelled", "done"], [3, 5, 13, null])),
    ).toEqual({ done: 2, total: 3, points: 8, pointsDone: 3 });
  });
});

describe("rangeOf", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  const child = (start: number | null, due: number | null) => ({
    start: start === null ? null : day(start),
    due: due === null ? null : day(due),
  });

  test("its own dates win over the children's", () => {
    expect(rangeOf(child(5, 20), [child(1, 30)])).toEqual({
      start: day(5),
      end: day(20),
      startDerived: false,
      endDerived: false,
    });
  });

  test("without its own, the start is the earliest child start or due date, the end the latest due date", () => {
    expect(
      rangeOf(child(null, null), [child(null, 4), child(3, 9), child(8, 6)]),
    ).toEqual({
      start: day(3),
      end: day(9),
      startDerived: true,
      endDerived: true,
    });
  });

  test("each end is derived on its own", () => {
    expect(rangeOf(child(2, null), [child(5, 9)])).toEqual({
      start: day(2),
      end: day(9),
      startDerived: false,
      endDerived: true,
    });
  });

  test("no dates anywhere: no range, nothing derived", () => {
    expect(rangeOf(child(null, null), [child(null, null)])).toEqual({
      start: null,
      end: null,
      startDerived: false,
      endDerived: false,
    });
    expect(rangeOf(child(null, null), [])).toEqual({
      start: null,
      end: null,
      startDerived: false,
      endDerived: false,
    });
  });
});

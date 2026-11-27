import { describe, expect, test } from "bun:test";
import {
  defaultEnd,
  defaultName,
  isFinished,
  plannable,
  pointsOf,
} from "./sprints.utils";

describe("sprint utils", () => {
  test("a sprint is named by its number", () => {
    expect(defaultName(3)).toBe("Sprint 3");
  });

  test("the end is whole weeks after the start", () => {
    const start = new Date("2026-03-02T00:00:00Z");
    expect(defaultEnd(start, 2).toISOString()).toBe("2026-03-16T00:00:00.000Z");
    expect(defaultEnd(start, 1).toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  test("done and cancelled issues are finished, the others are not", () => {
    expect(isFinished("done")).toBe(true);
    expect(isFinished("cancelled")).toBe(true);
    expect(isFinished("inProgress")).toBe(false);
    expect(isFinished("backlog")).toBe(false);
  });

  test("points add up and an unestimated issue counts for none", () => {
    expect(pointsOf([{ points: 3 }, { points: null }, {}, { points: 5 }])).toBe(
      8,
    );
    expect(pointsOf([])).toBe(0);
  });

  test("epics and sub-tasks are not planned, an issue with no type is a task", () => {
    expect(plannable([{ type: "story" }, {}, { type: "bug" }])).toBe(true);
    expect(plannable([{ type: "task" }, { type: "epic" }])).toBe(false);
    expect(plannable([{ type: "subTask" }])).toBe(false);
  });
});

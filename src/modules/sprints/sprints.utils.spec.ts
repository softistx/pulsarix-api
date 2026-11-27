import { describe, expect, test } from "bun:test";
import {
  averageOf,
  defaultEnd,
  defaultName,
  idealRemaining,
  isFinished,
  latestUpTo,
  plannable,
  pointsOf,
} from "./sprints.utils";

describe("sprint utils", () => {
  test("a sprint is named by its number", () => {
    expect(defaultName(3)).toBe("Sprint 3");
  });

  test("the end is whole weeks after the start", () => {
    const start = new Date("2026-03-02T00:00:00Z");
    expect(defaultEnd(start, 2, "UTC").toISOString()).toBe(
      "2026-03-16T00:00:00.000Z",
    );
    expect(defaultEnd(start, 1, "UTC").toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
  });

  test("the end keeps the wall-clock time across a clock change", () => {
    // Monday 10:00 in New York (EST), the clocks go forward on Sunday 8 March.
    const start = new Date("2026-03-02T15:00:00Z");
    expect(defaultEnd(start, 1, "America/New_York").toISOString()).toBe(
      "2026-03-09T14:00:00.000Z",
    );
    expect(defaultEnd(start, 1, "UTC").toISOString()).toBe(
      "2026-03-09T15:00:00.000Z",
    );
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

describe("burndown helpers", () => {
  test("the ideal line falls evenly to nothing on the last day", () => {
    expect(idealRemaining(10, 0, 5)).toBe(10);
    expect(idealRemaining(10, 1, 5)).toBe(8);
    expect(idealRemaining(10, 5, 5)).toBe(0);
    expect(idealRemaining(10, 7, 5)).toBe(0);
    expect(idealRemaining(10, 0, 0)).toBe(0);
    expect(idealRemaining(7, 1, 3)).toBe(4.67);
  });

  test("the average is to one decimal and 0 with nothing", () => {
    expect(averageOf([])).toBe(0);
    expect(averageOf([5, 3, 8])).toBe(5.3);
    expect(averageOf([5, 6])).toBe(5.5);
  });

  test("a day ends with the latest snapshot counted to it or before", () => {
    const at = (day: string, hour: number) => ({
      day,
      takenAt: new Date(Date.UTC(2026, 10, 1, hour)),
      n: `${day}/${hour}`,
    });
    const log = [at("2026-11-02", 9), at("2026-11-01", 8), at("2026-11-02", 3)];
    expect(latestUpTo(log, "2026-10-31")).toBeNull();
    expect(latestUpTo(log, "2026-11-01")?.n).toBe("2026-11-01/8");
    expect(latestUpTo(log, "2026-11-05")?.n).toBe("2026-11-02/9");
  });
});

import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { Move } from "~/issues";
import {
  CloseSprint,
  StartSprint,
  UpdateProject,
  withSprints,
} from "~/sprints";

describe("starting and closing sprints", () => {
  test("a sprint starts with its scope as committed points and the end from the project's length", async () => {
    const t = await withSprints("STA");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "story", points: 5 });
    const b = await t.make("B", { type: "task", points: 3 });
    await t.make("Outside", { type: "task", points: 8 });
    await t.plan([a, b], sprint.id);
    const started = await t.start(sprint.id, { name: "Launch", goal: "Go" });
    expect(started.state).toBe("active");
    expect(started.name).toBe("Launch");
    expect(started.goal).toBe("Go");
    expect(started.committedPoints).toBe(8);
    expect(started.startDate).toBe("2026-03-02T00:00:00.000Z");
    expect(started.endDate).toBe("2026-03-16T00:00:00.000Z");
  });

  test("the committed points leave out the cancelled issues", async () => {
    const t = await withSprints("CAN");
    const cancelled = t.project.statuses.find(
      (s) => s.category === "cancelled",
    );
    if (!cancelled) throw new Error("no cancelled status");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "story", points: 5 });
    const b = await t.make("B", { type: "task", points: 3 });
    await t.plan([a, b], sprint.id);
    await t.asOwner.call(Move, { id: b.id, statusId: cancelled.id });
    const started = await t.start(sprint.id);
    expect(started.committedPoints).toBe(5);
  });

  test("the default end follows the project's sprint length", async () => {
    const t = await withSprints("WKS");
    await t.asOwner.call(UpdateProject, {
      id: t.project.id,
      input: { sprintLengthWeeks: 1 },
    });
    const started = await t.start((await t.sprint()).id);
    expect(started.endDate).toBe("2026-03-09T00:00:00.000Z");
  });

  test("a second active sprint is refused", async () => {
    const t = await withSprints("TWO");
    const first = await t.sprint();
    const second = await t.sprint();
    await t.start(first.id);
    const refused = await t.asOwner.attempt(StartSprint, {
      id: second.id,
      input: { startDate: "2026-03-02T00:00:00Z" },
    });
    expect(codeOf(refused)).toBe("sprints.errors.active-exists");
    expect((await t.all(["active"])).map((s) => s.id)).toEqual([first.id]);
  });

  test("only a planned sprint starts, and its end is not before its start", async () => {
    const t = await withSprints("NPL");
    const sprint = await t.sprint();
    const bad = await t.asOwner.attempt(StartSprint, {
      id: sprint.id,
      input: {
        startDate: "2026-03-10T00:00:00Z",
        endDate: "2026-03-01T00:00:00Z",
      },
    });
    expect(codeOf(bad)).toBe("validation.errors.invalid-input");
    await t.start(sprint.id);
    const again = await t.asOwner.attempt(StartSprint, {
      id: sprint.id,
      input: { startDate: "2026-03-02T00:00:00Z" },
    });
    expect(codeOf(again)).toBe("sprints.errors.not-planned");
  });

  test("closing moves the unfinished issues to the next planned sprint and keeps the done ones", async () => {
    const t = await withSprints("CLS");
    const current = await t.sprint();
    const next = await t.sprint();
    const done = await t.make("Done", {
      type: "story",
      points: 5,
      statusId: t.done,
    });
    const open = await t.make("Open", {
      type: "task",
      points: 3,
      statusId: t.inProgress,
    });
    const todo = await t.make("Todo", {
      type: "bug",
      points: 2,
      statusId: t.todo,
    });
    await t.plan([done, open, todo], current.id);
    await t.start(current.id);
    const closed = await t.close(current.id, { unfinished: "NEXT_SPRINT" });
    expect(closed.state).toBe("closed");
    expect(closed.committedPoints).toBe(10);
    expect(closed.completedPoints).toBe(5);
    expect(closed.closedAt).not.toBeNull();
    expect(await t.titles({ sprintId: current.id })).toEqual(["Done"]);
    expect((await t.titles({ sprintId: next.id })).sort()).toEqual([
      "Open",
      "Todo",
    ]);
  });

  test("closing makes the next sprint when none is planned", async () => {
    const t = await withSprints("NEW");
    const current = await t.sprint();
    const open = await t.make("Open", { type: "task", statusId: t.todo });
    await t.plan([open], current.id);
    await t.start(current.id);
    await t.close(current.id);
    const sprints = await t.all();
    expect(sprints.map((s) => [s.number, s.name, s.state])).toEqual([
      [1, "Sprint 1", "closed"],
      [2, "Sprint 2", "planned"],
    ]);
    expect(await t.titles({ sprintId: sprints[1]?.id })).toEqual(["Open"]);
  });

  test("closing can name the sprint that takes them, or send them to the backlog", async () => {
    const t = await withSprints("CHO");
    const a = await t.sprint();
    const b = await t.sprint();
    const c = await t.sprint();
    const open = await t.make("Open", { type: "task", statusId: t.todo });
    await t.plan([open], a.id);
    await t.start(a.id);
    await t.close(a.id, { unfinished: "NEXT_SPRINT", nextSprintId: c.id });
    expect(await t.titles({ sprintId: c.id })).toEqual(["Open"]);
    expect(await t.titles({ sprintId: b.id })).toEqual([]);

    await t.start(b.id);
    const back = await t.make("Back", { type: "task", statusId: t.todo });
    await t.plan([back], b.id);
    await t.close(b.id, { unfinished: "BACKLOG" });
    expect(await t.titles({ sprintId: b.id })).toEqual([]);
    expect(await t.titles({ backlog: true })).toEqual(["Back"]);
  });

  test("a chosen next sprint must be a planned sprint of the project", async () => {
    const t = await withSprints("BAD");
    const a = await t.sprint();
    const b = await t.sprint();
    await t.start(b.id);
    await t.close(b.id, { unfinished: "BACKLOG" });
    const open = await t.make("Open", { type: "task", statusId: t.todo });
    await t.plan([open], a.id);
    await t.start(a.id);
    const refused = await t.asOwner.attempt(CloseSprint, {
      id: a.id,
      input: { unfinished: "NEXT_SPRINT", nextSprintId: b.id },
    });
    expect(codeOf(refused)).toBe("sprints.errors.not-planned");
    expect((await t.all(["active"])).map((s) => s.id)).toEqual([a.id]);
  });

  test("only the active sprint closes", async () => {
    const t = await withSprints("NAC");
    const sprint = await t.sprint();
    const planned = await t.asOwner.attempt(CloseSprint, {
      id: sprint.id,
      input: { unfinished: "BACKLOG" },
    });
    expect(codeOf(planned)).toBe("sprints.errors.not-active");
  });
});

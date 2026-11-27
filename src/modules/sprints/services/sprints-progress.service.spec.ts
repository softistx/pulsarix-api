import { describe, expect, test } from "bun:test";
import { Move } from "~/issues";
import { SprintsProgress, withSprints } from "~/sprints";

interface Row {
  id: string;
  progress: {
    points: number;
    pointsDone: number;
    issues: number;
    issuesDone: number;
  };
}

describe("Sprint.progress", () => {
  test("a sprint with no issue is all zero", async () => {
    const t = await withSprints("SPA");
    const sprint = await t.sprint();
    const { sprints } = await t.asOwner.call<{ sprints: Row[] }>(
      SprintsProgress,
      { projectId: t.project.id },
    );
    expect(sprints.find((s) => s.id === sprint.id)?.progress).toEqual({
      points: 0,
      pointsDone: 0,
      issues: 0,
      issuesDone: 0,
    });
  });

  test("cancelled issues are left out and done ones counted, per sprint", async () => {
    const t = await withSprints("SPB");
    const first = await t.sprint();
    const second = await t.sprint();
    const a = await t.make("A", { type: "story", points: 5 });
    const b = await t.make("B", { type: "task", points: 3 });
    const c = await t.make("C", { type: "task", points: 8 });
    const d = await t.make("D", { type: "task" });
    const e = await t.make("E", { type: "task", points: 2 });
    await t.plan([a, b, c, d], first.id);
    await t.plan([e], second.id);
    const cancelled = t.project.statuses.find(
      (s) => s.category === "cancelled",
    );
    if (!cancelled) throw new Error("no cancelled status");
    await t.asOwner.call(Move, { id: a.id, statusId: t.done });
    await t.asOwner.call(Move, { id: c.id, statusId: cancelled.id });
    const { sprints } = await t.asOwner.call<{ sprints: Row[] }>(
      SprintsProgress,
      { projectId: t.project.id },
    );
    const of = (id: string) => sprints.find((s) => s.id === id)?.progress;
    // a (done, 5), b (open, 3), d (open, unestimated); c is cancelled.
    expect(of(first.id)).toEqual({
      points: 8,
      pointsDone: 5,
      issues: 3,
      issuesDone: 1,
    });
    expect(of(second.id)).toEqual({
      points: 2,
      pointsDone: 0,
      issues: 1,
      issuesDone: 0,
    });
  });
});

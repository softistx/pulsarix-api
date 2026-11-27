import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { Update, withProject } from "~/issues";
import { PlanIssues, UpdateProject, withSprints } from "~/sprints";

describe("planning issues (their sprint and plan rank)", () => {
  test("an existing issue sits at the end of the backlog in the order it was made", async () => {
    const t = await withProject("RNK");
    const a = await t.make("A");
    const b = await t.make("B");
    expect(await t.titles({}, { field: "planRank" })).toEqual(["A", "B"]);
    expect(a.id).not.toBe(b.id);
  });

  test("planning changes an issue's sprint and keeps its plan rank when planned again", async () => {
    const t = await withSprints("ACT");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "task" });
    const [planned] = await t.plan([a], sprint.id);
    expect(planned?.sprintId).toBe(sprint.id);
    const again = await t.plan([a], sprint.id);
    expect(again[0]?.planRank).toBe(planned?.planRank as string);
  });

  test("an issue's sprint is not changed by updateIssue", async () => {
    const t = await withSprints("UPI");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "task" });
    await t.plan([a], sprint.id);
    await t.asOwner.call(Update, { id: a.id, input: { title: "A2" } });
    expect(await t.titles({ sprintId: sprint.id })).toEqual(["A2"]);
  });

  test("planning needs the project's sprints on", async () => {
    const t = await withSprints("OFF");
    const a = await t.make("A", { type: "task" });
    await t.asOwner.call(UpdateProject, {
      id: t.project.id,
      input: { sprintsEnabled: false },
    });
    const refused = await t.asOwner.attempt(PlanIssues, {
      ids: [a.id],
      sprintId: null,
    });
    expect(codeOf(refused)).toBe("sprints.errors.disabled");
  });
});

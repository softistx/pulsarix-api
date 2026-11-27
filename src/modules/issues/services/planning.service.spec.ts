import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { Update, withProject } from "~/issues";
import { PlanIssues, UpdateProject, withSprints } from "~/sprints";

describe("planning issues (their sprint and plan rank)", () => {
  test("issues made in turn rank in the order they were made", async () => {
    const t = await withProject("RNK");
    await t.make("A");
    await t.make("B");
    expect(await t.titles({}, { field: "planRank" })).toEqual(["A", "B"]);
  });

  test("planning changes an issue's sprint; planned again alone in it, it keeps its plan rank", async () => {
    const t = await withSprints("ACT");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "task" });
    const [planned] = await t.plan([a], sprint.id);
    expect(planned?.sprintId).toBe(sprint.id);
    const again = await t.plan([a], sprint.id);
    expect(again[0]?.planRank).toBe(planned?.planRank as string);
  });

  test("planned again with no placement, an issue goes after the others of its sprint", async () => {
    const t = await withSprints("RE2");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "task" });
    const b = await t.make("B", { type: "task" });
    const [first] = await t.plan([a, b], sprint.id);
    expect(
      await t.titles({ sprintId: sprint.id }, { field: "planRank" }),
    ).toEqual(["A", "B"]);
    // A alone is "moved": it is placed after B, so it does not keep its rank.
    const [again] = await t.plan([a], sprint.id);
    expect(again?.planRank).not.toBe(first?.planRank as string);
    expect(
      await t.titles({ sprintId: sprint.id }, { field: "planRank" }),
    ).toEqual(["B", "A"]);
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

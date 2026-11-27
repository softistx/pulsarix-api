import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { withProject } from "~/issues";
import { PlanIssues, withSprints } from "~/sprints";

describe("planning issues into sprints", () => {
  test("issues join a sprint at the end, in the order given, and leave it for the backlog", async () => {
    const t = await withSprints("PLN");
    const sprint = await t.sprint();
    const [a, b, c] = [
      await t.make("A", { type: "story" }),
      await t.make("B", { type: "task" }),
      await t.make("C", { type: "bug" }),
    ];
    const planned = await t.plan([c, a], sprint.id);
    expect(planned.map((i) => i.title)).toEqual(["C", "A"]);
    expect(planned.every((i) => i.sprintId === sprint.id)).toBe(true);
    await t.plan([b], sprint.id);
    expect(
      await t.titles({ sprintId: sprint.id }, { field: "planRank" }),
    ).toEqual(["C", "A", "B"]);
    const back = await t.plan([a], null);
    expect(back[0]?.sprintId).toBeNull();
    expect(
      await t.titles({ sprintId: sprint.id }, { field: "planRank" }),
    ).toEqual(["C", "B"]);
  });

  test("a placement puts issues between neighbours", async () => {
    const t = await withSprints("PLC");
    const sprint = await t.sprint();
    const [a, b, c] = [
      await t.make("A", { type: "task" }),
      await t.make("B", { type: "task" }),
      await t.make("C", { type: "task" }),
    ];
    await t.plan([a, b], sprint.id);
    await t.plan([c], sprint.id, { afterId: a.id, beforeId: b.id });
    expect(
      await t.titles({ sprintId: sprint.id }, { field: "planRank" }),
    ).toEqual(["A", "C", "B"]);
    await t.plan([c], sprint.id, { beforeId: a.id });
    expect(
      await t.titles({ sprintId: sprint.id }, { field: "planRank" }),
    ).toEqual(["C", "A", "B"]);
  });

  test("neighbours outside the sprint or out of order are refused", async () => {
    const t = await withSprints("PLD");
    const sprint = await t.sprint();
    const [a, b, c] = [
      await t.make("A", { type: "task" }),
      await t.make("B", { type: "task" }),
      await t.make("C", { type: "task" }),
    ];
    await t.plan([a, b], sprint.id);
    const outside = await t.asOwner.attempt(PlanIssues, {
      ids: [c.id],
      sprintId: sprint.id,
      afterId: c.id,
    });
    expect(codeOf(outside)).toBe("issues.errors.bad-placement");
    const reversed = await t.asOwner.attempt(PlanIssues, {
      ids: [c.id],
      sprintId: sprint.id,
      afterId: b.id,
      beforeId: a.id,
    });
    expect(codeOf(reversed)).toBe("issues.errors.bad-placement");
  });

  test("epics and sub-tasks are not planned", async () => {
    const t = await withSprints("PLE");
    const sprint = await t.sprint();
    const epic = await t.make("Epic", { type: "epic" });
    const story = await t.make("Story", { type: "story", parentId: epic.id });
    const sub = await t.make("Sub", { type: "subTask", parentId: story.id });
    for (const issue of [epic, sub]) {
      const refused = await t.asOwner.attempt(PlanIssues, {
        ids: [issue.id],
        sprintId: sprint.id,
      });
      expect(codeOf(refused)).toBe("sprints.errors.type-not-allowed");
    }
    expect(await t.titles({ sprintId: sprint.id })).toEqual([]);
  });

  test("a closed sprint takes no issue and gives none back", async () => {
    const t = await withSprints("PLX");
    const sprint = await t.sprint();
    const next = await t.sprint();
    const done = await t.make("Done", { type: "task", statusId: t.done });
    const other = await t.make("Other", { type: "task" });
    await t.plan([done], sprint.id);
    await t.start(sprint.id);
    await t.close(sprint.id);
    const into = await t.asOwner.attempt(PlanIssues, {
      ids: [other.id],
      sprintId: sprint.id,
    });
    expect(codeOf(into)).toBe("sprints.errors.closed");
    const out = await t.asOwner.attempt(PlanIssues, {
      ids: [done.id],
      sprintId: next.id,
    });
    expect(codeOf(out)).toBe("sprints.errors.closed");
  });

  test("the sprint must be the issues' project's", async () => {
    const t = await withSprints("PLP");
    const other = await withProject("OTH");
    const issue = await t.make("A", { type: "task" });
    const refused = await t.asOwner.attempt(PlanIssues, {
      ids: [issue.id],
      sprintId: other.project.id,
    });
    expect(codeOf(refused)).toBe("sprints.errors.not-found");
  });

  test("the lists: the backlog, a sprint and the active sprint", async () => {
    const t = await withSprints("FLT");
    const sprint = await t.sprint();
    const inSprint = await t.make("In sprint", {
      type: "task",
      statusId: t.todo,
    });
    await t.make("Backlog", { type: "task", statusId: t.backlog });
    await t.make("Epic", { type: "epic" });
    await t.make("Done", { type: "task", statusId: t.done });
    await t.plan([inSprint], sprint.id);
    expect(await t.titles({ backlog: true })).toEqual(["Backlog"]);
    expect(await t.titles({ sprintId: sprint.id })).toEqual(["In sprint"]);
    expect(await t.titles({ activeSprint: true })).toEqual([]);
    await t.start(sprint.id);
    expect(await t.titles({ activeSprint: true })).toEqual(["In sprint"]);
  });

  test("a project without sprints lists and plans as before", async () => {
    const t = await withProject("OLD");
    await t.make("A", { type: "task" });
    await t.make("B", { type: "task" });
    expect((await t.titles()).sort()).toEqual(["A", "B"]);
    const issue = await t.make("C", { type: "task" });
    const refused = await t.asOwner.attempt(PlanIssues, {
      ids: [issue.id],
      sprintId: null,
    });
    expect(codeOf(refused)).toBe("sprints.errors.disabled");
    expect(await t.titles({ activeSprint: true })).toEqual([]);
  });
});

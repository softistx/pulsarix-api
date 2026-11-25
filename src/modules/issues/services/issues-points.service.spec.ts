import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { ByKey, Create, type Issue, Update, withProject } from "~/issues";

const Bulk = `mutation($ids: [ID!]!, $input: BulkUpdateIssueInput!) {
  updateIssues(ids: $ids, input: $input) {
    updated { id points }
    failures { id code }
  }
}`;
const Activity = `query($issueId: ID) {
  activity(issueId: $issueId) { nodes { verb changes { field from to } } }
}`;

async function setup() {
  const t = await withProject();
  const attempt = async (input: Record<string, unknown>) =>
    codeOf(
      await t.asOwner.attempt(Create, {
        input: { projectId: t.project.id, title: "x", ...input },
      }),
    );
  const change = async (id: string, input: Record<string, unknown>) =>
    codeOf(await t.asOwner.attempt(Update, { id, input }));
  const pointsOf = async (key: string) =>
    (await t.asOwner.call<{ issue: Issue }>(ByKey, { key })).issue.points;
  return { ...t, attempt, change, pointsOf };
}

describe("story points", () => {
  test("a Story, a Task and a Bug carry points; none is the default", async () => {
    const { make } = await setup();
    expect((await make("Plain")).points).toBeNull();
    expect((await make("S", { type: "story", points: 8 })).points).toBe(8);
    expect((await make("T", { points: 1 })).points).toBe(1);
    expect((await make("B", { type: "bug", points: 21 })).points).toBe(21);
  });

  test("a value off the Fibonacci scale is a 400", async () => {
    const { make, attempt, change } = await setup();
    for (const points of [0, 4, 6, 22, -1]) {
      expect(await attempt({ points })).toBe("issues.errors.points-off-scale");
    }
    const task = await make("T");
    expect(await change(task.id, { points: 4 })).toBe(
      "issues.errors.points-off-scale",
    );
  });

  test("an Epic or a Sub-task refuses points with a 409", async () => {
    const { make, attempt, change } = await setup();
    expect(await attempt({ type: "epic", points: 3 })).toBe(
      "issues.errors.points-not-allowed",
    );
    const story = await make("S", { type: "story" });
    expect(
      await attempt({ type: "subTask", parentId: story.id, points: 3 }),
    ).toBe("issues.errors.points-not-allowed");
    const epic = await make("E", { type: "epic" });
    expect(await change(epic.id, { points: 5 })).toBe(
      "issues.errors.points-not-allowed",
    );
    const task = await make("T", { points: 2 });
    expect(await change(task.id, { type: "epic", points: 2 })).toBe(
      "issues.errors.points-not-allowed",
    );
  });

  test("updating sets, changes and clears the points", async () => {
    const { make, change, pointsOf, asOwner } = await setup();
    const task = await make("T");
    expect(await change(task.id, { points: 5 })).toBeUndefined();
    expect(await pointsOf(task.key)).toBe(5);
    expect(await change(task.id, { points: null })).toBeUndefined();
    expect(await pointsOf(task.key)).toBeNull();
    await change(task.id, { points: 3 });
    const { activity } = await asOwner.call<{
      activity: { nodes: { changes: { field: string }[] }[] };
    }>(Activity, { issueId: task.id });
    expect(
      activity.nodes.flatMap((n) => n.changes.map((c) => c.field)),
    ).toContain("points");
  });

  test("a change to an Epic or a Sub-task clears the points, in the activity", async () => {
    const { make, change, pointsOf, asOwner } = await setup();
    const story = await make("S", { type: "story" });
    const task = await make("T", { points: 8 });
    expect(
      await change(task.id, { type: "subTask", parentId: story.id }),
    ).toBeUndefined();
    expect(await pointsOf(task.key)).toBeNull();
    const other = await make("O", { type: "bug", points: 13 });
    expect(await change(other.id, { type: "epic" })).toBeUndefined();
    expect(await pointsOf(other.key)).toBeNull();
    const { activity } = await asOwner.call<{
      activity: {
        nodes: {
          verb: string;
          changes: { field: string; from: unknown; to: unknown }[];
        }[];
      };
    }>(Activity, { issueId: other.id });
    const cleared = activity.nodes
      .flatMap((n) => n.changes)
      .find((c) => c.field === "points");
    expect(cleared).toBeDefined();
    expect(cleared?.to ?? null).toBeNull();
  });

  test("a type change between points types keeps the points", async () => {
    const { make, change, pointsOf } = await setup();
    const task = await make("T", { points: 5 });
    await change(task.id, { type: "bug" });
    expect(await pointsOf(task.key)).toBe(5);
  });

  test("an Epic sums the points of its children, the done ones apart", async () => {
    const { make, asOwner, done, inProgress, project } = await setup();
    const cancelled = project.statuses.find((s) => s.category === "cancelled");
    const epic = await make("E", { type: "epic" });
    const child = (extra: Record<string, unknown>) =>
      make("c", { parentId: epic.id, ...extra });
    await child({ points: 3, statusId: done });
    await child({ type: "story", points: 5, statusId: inProgress });
    await child({ points: 8, statusId: done });
    await child({ type: "bug" });
    if (cancelled) await child({ points: 13, statusId: cancelled.id });
    const { issue } = await asOwner.call<{ issue: Issue }>(ByKey, {
      key: epic.key,
    });
    expect(issue.progress).toEqual({
      done: 2,
      total: 4,
      points: 16,
      pointsDone: 11,
    });
  });

  test("bulk: sets points, skips the refused rows and keeps going", async () => {
    const { make, asOwner } = await setup();
    const a = await make("A");
    const epic = await make("E", { type: "epic" });
    const b = await make("B", { type: "bug" });
    const { updateIssues } = await asOwner.call<{
      updateIssues: {
        updated: { id: string; points: number | null }[];
        failures: { id: string; code: string }[];
      };
    }>(Bulk, { ids: [a.id, epic.id, b.id], input: { points: 5 } });
    expect(updateIssues.updated.map((u) => [u.id, u.points])).toEqual([
      [a.id, 5],
      [b.id, 5],
    ]);
    expect(updateIssues.failures).toEqual([
      { id: epic.id, code: "issues.errors.points-not-allowed" },
    ]);
    const cleared = await asOwner.call<{
      updateIssues: { updated: { points: number | null }[] };
    }>(Bulk, { ids: [a.id, epic.id], input: { points: null } });
    expect(cleared.updateIssues.updated.map((u) => u.points)).toEqual([
      null,
      null,
    ]);
  });

  test("bulk: a value off the scale refuses the whole call", async () => {
    const { make, asOwner } = await setup();
    const a = await make("A");
    expect(
      codeOf(
        await asOwner.attempt(Bulk, { ids: [a.id], input: { points: 7 } }),
      ),
    ).toBe("issues.errors.points-off-scale");
  });

  test("the list sorts by points", async () => {
    const { make, titles } = await setup();
    await make("Three", { points: 3 });
    await make("Eight", { points: 8 });
    await make("One", { points: 1 });
    expect(
      await titles(undefined, { field: "points", direction: "asc" }),
    ).toEqual(["One", "Three", "Eight"]);
    const desc = await titles(undefined, {
      field: "points",
      direction: "desc",
    });
    expect(desc.indexOf("Eight")).toBeLessThan(desc.indexOf("Three"));
    expect(desc.indexOf("Three")).toBeLessThan(desc.indexOf("One"));
  });
});

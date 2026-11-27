import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOf } from "~/http";
import { ByKey, Create, Move, Update, withProject } from "~/issues";
import { withSprints } from "~/sprints";
import { tenancy } from "../../../config/db";
import type { SprintsMongo } from "../../sprints/sprints.types";

const ACTIVITY_QUERY = `query($issueId: ID) {
  activity(issueId: $issueId) { nodes { verb changes { field } } }
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
  return { ...t, attempt, change };
}

describe("an issue that becomes an epic or a sub-task", () => {
  const stored = async (organisationId: string, id: string) => {
    const mongo = (await tenancy.databaseOf(
      organisationId,
    )) as unknown as SprintsMongo;
    return { mongo, issue: await mongo.db.issues.findById(new ObjectId(id)) };
  };

  test("goes back to the backlog, and an active sprint snapshots the change", async () => {
    const t = await withSprints("UNP");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "story", points: 5 });
    const b = await t.make("B", { type: "task", points: 3 });
    await t.plan([a, b], sprint.id);
    await t.start(sprint.id);
    await t.asOwner.call(Update, { id: b.id, input: { type: "epic" } });
    const { mongo, issue } = await stored(t.organisation.id, b.id);
    expect(issue).toMatchObject({ type: "epic", sprintId: null });
    const scope = await mongo.db.sprintSnapshots.findMany({
      filter: { reason: "scope" },
    });
    // The scope now counts A only.
    expect(scope.map((s) => s.scopePoints)).toEqual([5]);
  });

  test("a planned sprint just loses the issue", async () => {
    const t = await withSprints("UN2");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "task" });
    await t.plan([a], sprint.id);
    await t.asOwner.call(Update, { id: a.id, input: { type: "epic" } });
    const { mongo, issue } = await stored(t.organisation.id, a.id);
    expect(issue?.sprintId).toBeNull();
    expect(await mongo.db.sprintSnapshots.count({ reason: "scope" })).toBe(0);
  });
});

describe("issue types and parent rules", () => {
  test("an issue is a task by default, and its type is read back", async () => {
    const { make } = await setup();
    expect((await make("Plain")).type).toBe("task");
    expect((await make("Big", { type: "epic" })).type).toBe("epic");
  });

  test("creating: each parent rule is accepted or refused", async () => {
    const { make, attempt } = await setup();
    const epic = await make("E", { type: "epic" });
    const story = await make("S", { type: "story", parentId: epic.id });
    const task = await make("T", { parentId: epic.id });
    const bug = await make("B", { type: "bug" });
    await make("Sub", { type: "subTask", parentId: story.id });
    await make("Sub", { type: "subTask", parentId: task.id });
    await make("Sub", { type: "subTask", parentId: bug.id });
    expect(await attempt({ type: "epic", parentId: epic.id })).toBe(
      "issues.errors.parent-not-allowed",
    );
    expect(await attempt({ type: "story", parentId: story.id })).toBe(
      "issues.errors.parent-type-invalid",
    );
    expect(await attempt({ type: "task", parentId: task.id })).toBe(
      "issues.errors.parent-type-invalid",
    );
    expect(await attempt({ type: "subTask", parentId: epic.id })).toBe(
      "issues.errors.parent-type-invalid",
    );
    expect(await attempt({ type: "subTask" })).toBe(
      "issues.errors.parent-required",
    );
  });

  test("updating: the type and the parent are checked together", async () => {
    const { make, change, asOwner } = await setup();
    const epic = await make("E", { type: "epic" });
    const story = await make("S", { type: "story" });
    const task = await make("T");
    expect(await change(task.id, { type: "subTask" })).toBe(
      "issues.errors.parent-required",
    );
    expect(await change(task.id, { parentId: story.id })).toBe(
      "issues.errors.parent-type-invalid",
    );
    expect(await change(epic.id, { parentId: story.id })).toBe(
      "issues.errors.parent-not-allowed",
    );
    expect(await change(task.id, { type: null })).toBe(
      "validation.errors.invalid-input",
    );
    const sub = await asOwner.call<{ updateIssue: { type: string } }>(Update, {
      id: task.id,
      input: { type: "subTask", parentId: story.id },
    });
    expect(sub.updateIssue.type).toBe("subTask");
    const moved = await asOwner.call<{ updateIssue: { parentId: string } }>(
      Update,
      { id: story.id, input: { parentId: epic.id } },
    );
    expect(moved.updateIssue.parentId).toBe(epic.id);
  });

  test("an Epic with Story children cannot become a Story", async () => {
    const { make, change } = await setup();
    const epic = await make("E", { type: "epic" });
    await make("S", { type: "story", parentId: epic.id });
    expect(await change(epic.id, { type: "story" })).toBe(
      "issues.errors.type-breaks-children",
    );
    const parent = await make("P", { type: "task" });
    await make("Sub", { type: "subTask", parentId: parent.id });
    expect(await change(parent.id, { type: "epic" })).toBe(
      "issues.errors.type-breaks-children",
    );
  });

  test("a legacy link that breaks the rules survives an unrelated edit", async () => {
    const { make, change, asOwner, organisation } = await setup();
    const parent = await make("P");
    const child = await make("C");
    const mongo = await tenancy.databaseOf(organisation.id);
    await mongo.db.issues.raw.updateOne(
      { _id: new ObjectId(child.id) },
      { $set: { parentId: new ObjectId(parent.id) } },
    );
    const edited = await asOwner.call<{ updateIssue: { parentId: string } }>(
      Update,
      { id: child.id, input: { title: "C2", parentId: parent.id } },
    );
    expect(edited.updateIssue.parentId).toBe(parent.id);
    expect(await change(parent.id, { priority: "high" })).toBeUndefined();
  });

  test("an issue stored without a type reads as a task and matches the task filter", async () => {
    const { make, titles, asOwner, organisation } = await setup();
    const old = await make("Old");
    await make("Big", { type: "epic" });
    const mongo = await tenancy.databaseOf(organisation.id);
    await mongo.db.issues.raw.updateOne(
      { _id: new ObjectId(old.id) },
      { $unset: { type: "" } },
    );
    const read = await asOwner.call<{ issue: { type: string } }>(ByKey, {
      key: old.key,
    });
    expect(read.issue.type).toBe("task");
    expect(await titles({ types: ["task"] })).toEqual(["Old"]);
    expect(await titles({ types: ["epic"] })).toEqual(["Big"]);
    expect((await titles({ types: ["epic", "task"] })).sort()).toEqual([
      "Big",
      "Old",
    ]);
  });

  test("progress counts the finished children", async () => {
    const { make, asOwner, done } = await setup();
    const epic = await make("E", { type: "epic" });
    const one = await make("One", { parentId: epic.id });
    await make("Two", { parentId: epic.id });
    await asOwner.call(Move, { id: one.id, statusId: done });
    const read = await asOwner.call<{
      issue: { progress: { done: number; total: number } };
    }>(ByKey, { key: epic.key });
    expect(read.issue.progress).toMatchObject({ done: 1, total: 2 });
    const alone = await make("Alone");
    const own = await asOwner.call<{
      issue: {
        progress: {
          done: number;
          total: number;
          points: number;
          pointsDone: number;
        };
      };
    }>(ByKey, { key: alone.key });
    expect(own.issue.progress).toEqual({
      done: 0,
      total: 0,
      points: 0,
      pointsDone: 0,
    });
  });

  test("a type change is in the activity", async () => {
    const { make, asOwner } = await setup();
    const task = await make("T");
    await asOwner.call(Update, { id: task.id, input: { type: "bug" } });
    const { activity } = await asOwner.call<{
      activity: { nodes: { verb: string; changes: { field: string }[] }[] };
    }>(ACTIVITY_QUERY, { issueId: task.id });
    const fields = activity.nodes.flatMap((n) => n.changes.map((c) => c.field));
    expect(fields).toContain("type");
  });

  test("giving a legacy issue its effective type logs nothing", async () => {
    const { make, asOwner, organisation } = await setup();
    const old = await make("Old");
    const mongo = await tenancy.databaseOf(organisation.id);
    await mongo.db.issues.raw.updateOne(
      { _id: new ObjectId(old.id) },
      { $unset: { type: "" } },
    );
    await asOwner.call(Update, { id: old.id, input: { type: "task" } });
    const { activity } = await asOwner.call<{
      activity: {
        nodes: { verb: string; changes: { field: string }[] }[];
      };
    }>(ACTIVITY_QUERY, { issueId: old.id });
    const fields = activity.nodes
      .filter((n) => n.verb !== "created")
      .flatMap((n) => n.changes.map((c) => c.field));
    expect(fields).not.toContain("type");
  });
});

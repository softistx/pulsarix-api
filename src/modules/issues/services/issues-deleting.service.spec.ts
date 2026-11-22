import { describe, expect, test } from "bun:test";
import { ByKey, Delete, withProject } from "~/issues";

const ACTIVITY_QUERY = `query($issueId: ID) {
  activity(issueId: $issueId) { nodes { verb changes { field from to } } }
}`;

interface Row {
  verb: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

describe("deleting an issue with Sub-tasks", () => {
  for (const type of ["story", "task", "bug"] as const) {
    test(`deleting a ${type} turns its Sub-tasks into Tasks with no parent, one activity row each`, async () => {
      const { make, asOwner } = await withProject();
      const parent = await make("P", { type });
      const one = await make("One", { type: "subTask", parentId: parent.id });
      const two = await make("Two", { type: "subTask", parentId: parent.id });
      const other = await make("Other", { type: "task" });
      await asOwner.call(Delete, { id: parent.id });
      for (const sub of [one, two]) {
        const read = await asOwner.call<{
          issue: { type: string; parentId: string | null };
        }>(ByKey, { key: sub.key });
        expect(read.issue).toMatchObject({ type: "task", parentId: null });
        const { activity } = await asOwner.call<{
          activity: { nodes: Row[] };
        }>(ACTIVITY_QUERY, { issueId: sub.id });
        const updates = activity.nodes.filter((n) => n.verb === "updated");
        expect(updates).toHaveLength(1);
        expect(updates[0]?.changes).toEqual(
          expect.arrayContaining([
            { field: "type", from: "subTask", to: "task" },
            { field: "parentId", from: parent.id, to: null },
          ]),
        );
      }
      const untouched = await asOwner.call<{ issue: { type: string } }>(ByKey, {
        key: other.key,
      });
      expect(untouched.issue.type).toBe("task");
    });
  }

  test("deleting an Epic only clears its children's parent", async () => {
    const { make, asOwner } = await withProject();
    const epic = await make("E", { type: "epic" });
    const story = await make("S", { type: "story", parentId: epic.id });
    await asOwner.call(Delete, { id: epic.id });
    const read = await asOwner.call<{
      issue: { type: string; parentId: string | null };
    }>(ByKey, { key: story.key });
    expect(read.issue).toMatchObject({ type: "story", parentId: null });
  });

  test("a Sub-task's deletion leaves its parent alone", async () => {
    const { make, asOwner } = await withProject();
    const task = await make("T");
    const sub = await make("Sub", { type: "subTask", parentId: task.id });
    await asOwner.call(Delete, { id: sub.id });
    const read = await asOwner.call<{ issue: { type: string } }>(ByKey, {
      key: task.key,
    });
    expect(read.issue.type).toBe("task");
  });
});

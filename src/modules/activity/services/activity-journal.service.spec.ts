import { describe, expect, test } from "bun:test";
import {
  Activity,
  AddComment,
  DeleteIssue,
  journal,
  MoveIssue,
  type Row,
  setup,
  UpdateIssue,
} from "~/activity";
import { authApp } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

describe("the activity journal", () => {
  test("a change is journalled with its fields, newest first, and outlives the issue", async () => {
    const { asOwner, owner, project, issue, status } = await setup(kit);
    const created = await issue("First");
    await asOwner.call(UpdateIssue, {
      id: created.id,
      input: { title: "Renamed", priority: "high" },
    });
    await asOwner.call(MoveIssue, {
      id: created.id,
      statusId: status("done"),
    });
    await asOwner.call(DeleteIssue, { id: created.id });

    const { nodes } = await journal(asOwner, { projectId: project.id });
    expect(nodes.map((row) => row.verb)).toEqual([
      "deleted",
      "moved",
      "updated",
      "created",
    ]);
    const [, moved, updated, made] = nodes;
    expect(made?.issueKey).toBe("ABC-1");
    expect(made?.actorId).toBe(owner.id);
    expect(made?.changes.find((c) => c.field === "title")).toEqual({
      field: "title",
      from: null,
      to: "First",
    });
    expect(updated?.changes).toEqual([
      { field: "title", from: "First", to: "Renamed" },
      { field: "priority", from: "none", to: "high" },
    ]);
    expect(moved?.changes.map((c) => c.field)).toContain("statusId");
    // The issue is gone; its history is not.
    expect(nodes.every((row) => row.issueId === created.id)).toBe(true);
  });

  test("an update that changes nothing, and a refused write, leave no row", async () => {
    const { asOwner, project, issue, status } = await setup(kit);
    const created = await issue();
    const before = (await journal(asOwner, { issueId: created.id })).nodes;
    await asOwner.call(UpdateIssue, {
      id: created.id,
      input: { title: "An issue" },
    });
    // A neighbour that is not in the column: refused, and so is its activity.
    const refused = await asOwner.attempt(MoveIssue, {
      id: created.id,
      statusId: status("done"),
      beforeId: created.id,
    });
    expect(refused.errors).toBeDefined();
    const after = (await journal(asOwner, { projectId: project.id })).nodes;
    expect(after).toHaveLength(before.length);
  });

  test("comments are journalled on their issue", async () => {
    const { asOwner, issue } = await setup(kit);
    const created = await issue();
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: "Hello" },
    });
    const { nodes } = await journal(asOwner, { issueId: created.id });
    expect(nodes.map((row) => row.verb)).toEqual(["commented", "created"]);
  });

  test("the journal is paged, and needs exactly one scope", async () => {
    const { asOwner, project, issue } = await setup(kit);
    await issue("A");
    await issue("B");
    await issue("C");
    const first = await journal(asOwner, { projectId: project.id });
    expect(first.nodes).toHaveLength(3);
    const page = await asOwner.call<{
      activity: {
        nodes: Row[];
        endCursor: string | null;
        hasNextPage: boolean;
      };
    }>(Activity, { projectId: project.id, first: 2 });
    expect(page.activity.hasNextPage).toBe(true);
    const rest = await asOwner.call<{ activity: { nodes: Row[] } }>(Activity, {
      projectId: project.id,
      first: 2,
      after: page.activity.endCursor,
    });
    expect(rest.activity.nodes).toHaveLength(1);
    expect(
      codeOf(await asOwner.attempt(Activity, { projectId: "0".repeat(24) })),
    ).toBe("projects.errors.not-found");
    expect(codeOf(await asOwner.attempt(Activity, {}))).toBe(
      "validation.errors.invalid-input",
    );
  });
});

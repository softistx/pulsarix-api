import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id statuses { id category } }
}`;
const CreateLabel = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { id }
}`;
const Create = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id statusId labelIds }
}`;
const Delete = `mutation($id: ID!) { deleteIssue(id: $id) }`;
const Bulk = `mutation($ids: [ID!]!, $input: BulkUpdateIssueInput!) {
  updateIssues(ids: $ids, input: $input) {
    updated { id priority statusId assigneeId labelIds dueDate estimateHours }
    failures { id code message }
  }
}`;
const Activity = `query($issueId: ID) {
  activity(issueId: $issueId) { nodes { verb changes { field } } }
}`;

interface Updated {
  id: string;
  priority: string;
  statusId: string;
  assigneeId: string | null;
  labelIds: string[];
  dueDate: string | null;
  estimateHours: number | null;
}
interface Result {
  updateIssues: {
    updated: Updated[];
    failures: { id: string; code: string; message: string }[];
  };
}

async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string; statuses: { id: string; category: string }[] };
  }>(CreateProject, { input: { key: "BLK", name: "Bulk" } });
  const make = async (title: string, extra: Record<string, unknown> = {}) =>
    (
      await asOwner.call<{
        createIssue: { id: string; statusId: string; labelIds: string[] };
      }>(Create, { input: { projectId: project.id, title, ...extra } })
    ).createIssue;
  const label = async (name: string) =>
    (
      await asOwner.call<{ createLabel: { id: string } }>(CreateLabel, {
        input: { projectId: project.id, name, colour: "#336699" },
      })
    ).createLabel.id;
  return { owner, organisation, asOwner, project, make, label };
}

describe("updating many issues", () => {
  test("one patch reaches every issue, with its own activity entry", async () => {
    const { asOwner, owner, project, make, label } = await setup();
    const [a, b] = [await make("A"), await make("B")] as const;
    const [red, blue] = [await label("red"), await label("blue")] as const;
    await asOwner.call(Bulk, {
      ids: [a.id],
      input: { addLabelIds: [red] },
    });
    const done = project.statuses.find((s) => s.category === "done");
    const { updateIssues } = await asOwner.call<Result>(Bulk, {
      ids: [a.id, b.id, a.id],
      input: {
        priority: "high",
        assigneeId: owner.id,
        statusId: done?.id,
        addLabelIds: [blue],
        removeLabelIds: [red],
        dueDate: "2026-03-09T00:00:00Z",
        estimateHours: 3,
      },
    });
    expect(updateIssues.failures).toEqual([]);
    expect(updateIssues.updated.map((i) => i.id)).toEqual([a.id, b.id]);
    for (const issue of updateIssues.updated) {
      expect(issue).toMatchObject({
        priority: "high",
        assigneeId: owner.id,
        statusId: done?.id,
        labelIds: [blue],
        dueDate: "2026-03-09T00:00:00.000Z",
        estimateHours: 3,
      });
    }
    const { activity } = await asOwner.call<{
      activity: { nodes: { verb: string; changes: { field: string }[] }[] };
    }>(Activity, { issueId: b.id });
    expect(activity.nodes.map((n) => n.verb)).toEqual([
      "moved",
      "updated",
      "created",
    ]);
    expect(activity.nodes[1]?.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(["priority", "assigneeId", "labelIds"]),
    );
    // Null clears the optional fields.
    const cleared = await asOwner.call<Result>(Bulk, {
      ids: [a.id],
      input: { assigneeId: null, dueDate: null, estimateHours: null },
    });
    expect(cleared.updateIssues.updated[0]).toMatchObject({
      assigneeId: null,
      dueDate: null,
      estimateHours: null,
    });
  });

  test("a mixed batch writes what it can and reports the rest", async () => {
    const { asOwner, make } = await setup();
    const [a, b] = [await make("A"), await make("B")] as const;
    await asOwner.call(Delete, { id: b.id });
    const missing = "64b7f0f0f0f0f0f0f0f0f0f0";
    const { updateIssues } = await asOwner.call<Result>(Bulk, {
      ids: [a.id, b.id, missing],
      input: { priority: "urgent" },
    });
    expect(updateIssues.updated.map((i) => i.id)).toEqual([a.id]);
    expect(updateIssues.failures.map((f) => [f.id, f.code])).toEqual([
      [b.id, "issues.errors.not-found"],
      [missing, "issues.errors.not-found"],
    ]);
  });

  test("an issue refused for its status, or its assignee, stays untouched", async () => {
    const { asOwner, make } = await setup();
    const other = await asOwner.call<{
      createProject: { statuses: { id: string }[] };
    }>(CreateProject, { input: { key: "OTH", name: "Other" } });
    const issue = await make("A");
    const foreign = other.createProject.statuses[0]?.id;
    const first = await asOwner.call<Result>(Bulk, {
      ids: [issue.id],
      input: { priority: "high", statusId: foreign },
    });
    expect(first.updateIssues.updated).toEqual([]);
    expect(first.updateIssues.failures[0]?.code).toBe(
      "validation.errors.invalid-input",
    );
    const stranger = await ownerWithOrganisation(kit);
    const second = await asOwner.call<Result>(Bulk, {
      ids: [issue.id],
      input: { priority: "high", assigneeId: stranger.owner.id },
    });
    expect(second.updateIssues.failures).toHaveLength(1);
    const after = await asOwner.call<Result>(Bulk, {
      ids: [issue.id],
      input: { estimateHours: 1 },
    });
    expect(after.updateIssues.updated[0]?.priority).toBe("none");
    expect(after.updateIssues.updated[0]?.statusId).toBe(issue.statusId);
  });

  test("the batch holds 1 to 100 ids and the patch is not empty", async () => {
    const { asOwner, make } = await setup();
    const issue = await make("A");
    const ids = Array.from({ length: 100 }, () => issue.id);
    const ok = await asOwner.call<Result>(Bulk, {
      ids,
      input: { priority: "low" },
    });
    expect(ok.updateIssues.updated).toHaveLength(1);
    for (const variables of [
      { ids: [...ids, issue.id], input: { priority: "low" } },
      { ids: [], input: { priority: "low" } },
      { ids: [issue.id], input: {} },
      { ids: [issue.id], input: { priority: null } },
      { ids: [issue.id], input: { estimateHours: -1 } },
    ]) {
      expect(codeOf(await asOwner.attempt(Bulk, variables))).toBe(
        "validation.errors.invalid-input",
      );
    }
  });

  test("members write, viewers are refused", async () => {
    const { organisation, owner, make } = await setup();
    const issue = await make("A");
    const as = async (role: "member" | "viewer") => {
      const m = await memberWith(kit, organisation.id, owner.token, role);
      return kit.client(m.token, { organisation: organisation.id });
    };
    const variables = { ids: [issue.id], input: { priority: "high" } };
    const done = await (await as("member")).call<Result>(Bulk, variables);
    expect(done.updateIssues.updated).toHaveLength(1);
    expect(codeOf(await (await as("viewer")).attempt(Bulk, variables))).toBe(
      "auth.errors.forbidden",
    );
    expect(
      codeOf(await kit.client(null, {}).attempt(Bulk, variables)),
    ).toBeDefined();
  });
});

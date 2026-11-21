import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();
const CODE = "issues.errors.project-archived";

const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id statuses { id category } }
}`;
const Archive = `mutation($id: ID!) { archiveProject(id: $id) { id archivedAt } }`;
const Unarchive = `mutation($id: ID!) { unarchiveProject(id: $id) { id archivedAt } }`;
const CreateLabel = `mutation($input: CreateLabelInput!) { createLabel(input: $input) { id } }`;
const Create = `mutation($input: CreateIssueInput!) { createIssue(input: $input) { id key } }`;
const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id title assigneeId labelIds }
}`;
const Move = `mutation($id: ID!, $statusId: ID!, $beforeId: ID) {
  moveIssue(id: $id, statusId: $statusId, beforeId: $beforeId) { id statusId }
}`;
const Delete = `mutation($id: ID!) { deleteIssue(id: $id) }`;
const Watch = `mutation($id: ID!) { watchIssue(id: $id) { watching } }`;
const Bulk = `mutation($ids: [ID!]!, $input: BulkUpdateIssueInput!) {
  updateIssues(ids: $ids, input: $input) {
    updated { id }
    failures { id code }
  }
}`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id body }
}`;
const EditComment = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { id body }
}`;
const DeleteComment = `mutation($id: ID!) { deleteComment(id: $id) }`;
const ByKey = `query($key: String!) { issue(key: $key) { id title } }`;
const List = `query($projectId: ID!) {
  issues(projectId: $projectId) { nodes { id title } }
}`;
const Comments = `query($issueId: ID!) {
  comments(issueId: $issueId) { nodes { id body } }
}`;

// An organisation with a project holding two issues, a comment and a label,
// all made while it is active; `archive()` then archives the project.
async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string; statuses: { id: string }[] };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const make = async (title: string) =>
    (
      await asOwner.call<{ createIssue: { id: string; key: string } }>(Create, {
        input: { projectId: project.id, title },
      })
    ).createIssue;
  const issue = await make("First");
  const other = await make("Second");
  const { addComment: comment } = await asOwner.call<{
    addComment: { id: string };
  }>(AddComment, { issueId: issue.id, input: { body: "hello" } });
  const { createLabel: label } = await asOwner.call<{
    createLabel: { id: string };
  }>(CreateLabel, {
    input: { projectId: project.id, name: "bug", colour: "#ff0000" },
  });
  const member = await memberWith(kit, organisation.id, owner.token, "member");
  return {
    owner,
    asOwner,
    asMember: as(member.token),
    member,
    project,
    issue,
    other,
    comment,
    label,
    statusId: project.statuses[1]?.id ?? "",
    archive: () => asOwner.call(Archive, { id: project.id }),
    unarchive: () => asOwner.call(Unarchive, { id: project.id }),
  };
}

describe("an archived project refuses the writes of its issues", () => {
  test("create, update, move, delete, assign, label and bulk are refused with 409", async () => {
    const w = await setup();
    await w.archive();

    const refused = [
      await w.asOwner.attempt(Create, {
        input: { projectId: w.project.id, title: "New" },
      }),
      await w.asOwner.attempt(Update, {
        id: w.issue.id,
        input: { title: "Renamed" },
      }),
      await w.asOwner.attempt(Update, {
        id: w.issue.id,
        input: { assigneeId: w.member.id },
      }),
      await w.asOwner.attempt(Update, {
        id: w.issue.id,
        input: { labelIds: [w.label.id] },
      }),
      await w.asMember.attempt(Move, {
        id: w.issue.id,
        statusId: w.statusId,
      }),
      await w.asOwner.attempt(Move, {
        id: w.issue.id,
        statusId: w.statusId,
        beforeId: w.other.id,
      }),
      await w.asOwner.attempt(Delete, { id: w.issue.id }),
    ];
    for (const attempt of refused) {
      expect(codeOf(attempt)).toBe(CODE);
    }
  });

  test("a bulk update lists every issue of the project as a failure", async () => {
    const w = await setup();
    await w.archive();
    const { updateIssues } = await w.asOwner.call<{
      updateIssues: {
        updated: { id: string }[];
        failures: { id: string; code: string }[];
      };
    }>(Bulk, {
      ids: [w.issue.id, w.other.id],
      input: { priority: "high", statusId: w.statusId },
    });
    expect(updateIssues.updated).toEqual([]);
    expect(updateIssues.failures.map((f) => f.code)).toEqual([CODE, CODE]);
  });

  test("comments are refused: add, edit and delete", async () => {
    const w = await setup();
    await w.archive();
    const add = await w.asOwner.attempt(AddComment, {
      issueId: w.issue.id,
      input: { body: "late" },
    });
    const edit = await w.asOwner.attempt(EditComment, {
      id: w.comment.id,
      input: { body: "edited" },
    });
    const remove = await w.asOwner.attempt(DeleteComment, {
      id: w.comment.id,
    });
    for (const attempt of [add, edit, remove]) {
      expect(codeOf(attempt)).toBe(CODE);
    }
  });

  test("reading still works, watching stays allowed, and unarchiving restores the writes", async () => {
    const w = await setup();
    await w.archive();

    const byKey = await w.asOwner.call<{ issue: { title: string } }>(ByKey, {
      key: w.issue.key,
    });
    expect(byKey.issue.title).toBe("First");
    const list = await w.asMember.call<{
      issues: { nodes: { id: string }[] };
    }>(List, { projectId: w.project.id });
    expect(list.issues.nodes).toHaveLength(2);
    const comments = await w.asOwner.call<{
      comments: { nodes: { body: string }[] };
    }>(Comments, { issueId: w.issue.id });
    expect(comments.comments.nodes.map((c) => c.body)).toEqual(["hello"]);
    const watched = await w.asMember.call<{
      watchIssue: { watching: boolean };
    }>(Watch, { id: w.issue.id });
    expect(watched.watchIssue.watching).toBe(true);

    const { unarchiveProject } = await w.unarchive();
    expect(unarchiveProject).toMatchObject({ archivedAt: null });
    const renamed = await w.asOwner.call<{ updateIssue: { title: string } }>(
      Update,
      { id: w.issue.id, input: { title: "Renamed" } },
    );
    expect(renamed.updateIssue.title).toBe("Renamed");
    await w.asOwner.call(AddComment, {
      issueId: w.issue.id,
      input: { body: "back" },
    });
  });

  test("an active project is untouched, and another project of the organisation too", async () => {
    const w = await setup();
    const { createProject: second } = await w.asOwner.call<{
      createProject: { id: string };
    }>(CreateProject, { input: { key: "XYZ", name: "Other" } });
    await w.archive();
    const created = await w.asOwner.call<{ createIssue: { key: string } }>(
      Create,
      { input: { projectId: second.id, title: "Alive" } },
    );
    expect(created.createIssue.key).toBe("XYZ-1");
  });
});

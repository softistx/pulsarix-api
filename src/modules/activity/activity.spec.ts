import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { subscribe } from "~/sse";

const kit = authApp();

const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id statuses { id category } }
}`;
const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key statusId }
}`;
const UpdateIssue = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id }
}`;
const MoveIssue = `mutation($id: ID!, $statusId: ID!, $beforeId: ID, $afterId: ID) {
  moveIssue(id: $id, statusId: $statusId, beforeId: $beforeId, afterId: $afterId) { id statusId rank }
}`;
const DeleteIssue = `mutation($id: ID!) { deleteIssue(id: $id) }`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
const Activity = `query($projectId: ID, $issueId: ID, $first: Int, $after: String) {
  activity(projectId: $projectId, issueId: $issueId, first: $first, after: $after) {
    nodes { id projectId issueId issueKey actorId verb changes { field from to } at }
    endCursor hasNextPage
  }
}`;
const Board = `subscription($projectId: ID!) {
  projectBoard(projectId: $projectId) {
    activityId verb projectId issueId issueKey actorId fields statusId rank at
  }
}`;
const IssueLive = `subscription($issueId: ID!) {
  issueChanged(issueId: $issueId) { activityId verb issueId issueKey fields }
}`;
const Notifications = `subscription { notificationReceived { notificationId kind unreadCount } }`;
const Reports = `subscription($projectId: ID!) {
  clientReportReceived(projectId: $projectId) { reportId title at }
}`;

interface Event {
  projectBoard: {
    activityId: string;
    verb: string;
    issueId: string;
    issueKey: string;
    fields: string[];
    statusId: string;
    rank: string;
  };
}
interface IssueEvent {
  issueChanged: { verb: string; issueId: string; fields: string[] };
}
interface Row {
  verb: string;
  issueId: string | null;
  issueKey: string | null;
  actorId: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string; statuses: { id: string; category: string }[] };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const status = (category: string) => {
    const found = project.statuses.find((s) => s.category === category);
    if (!found) throw new Error(`no ${category} status`);
    return found.id;
  };
  const issue = async (title = "An issue") =>
    (
      await asOwner.call<{
        createIssue: { id: string; key: string; statusId: string };
      }>(CreateIssue, { input: { projectId: project.id, title } })
    ).createIssue;
  const member = await memberWith(kit, organisation.id, owner.token, "member");
  const viewer = await memberWith(kit, organisation.id, owner.token, "viewer");
  const live =
    (token: string | null, org: string | null = organisation.id) =>
    <T = Record<string, unknown>>(
      query: string,
      variables?: Record<string, unknown>,
    ) =>
      subscribe<T>(
        kit,
        token,
        org ? { organisation: org } : {},
        query,
        variables,
      );
  return {
    owner,
    organisation,
    project,
    asOwner,
    as,
    issue,
    status,
    member,
    viewer,
    live,
  };
}

const journal = async (
  client: { call: <T>(q: string, v?: Record<string, unknown>) => Promise<T> },
  scope: { projectId?: string; issueId?: string },
) =>
  (
    await client.call<{
      activity: {
        nodes: Row[];
        endCursor: string | null;
        hasNextPage: boolean;
      };
    }>(Activity, scope)
  ).activity;

describe("the activity journal", () => {
  test("a change is journalled with its fields, newest first, and outlives the issue", async () => {
    const { asOwner, owner, project, issue, status } = await setup();
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
    const { asOwner, project, issue, status } = await setup();
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
    const { asOwner, issue } = await setup();
    const created = await issue();
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: "Hello" },
    });
    const { nodes } = await journal(asOwner, { issueId: created.id });
    expect(nodes.map((row) => row.verb)).toEqual(["commented", "created"]);
  });

  test("the journal is paged, and needs exactly one scope", async () => {
    const { asOwner, project, issue } = await setup();
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

describe("live events", () => {
  test("two clients see an issue move live", async () => {
    const { asOwner, project, issue, status, member, live, owner } =
      await setup();
    const created = await issue("Moving");
    const ada = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    const bob = await live(member.token)<Event>(Board, {
      projectId: project.id,
    });
    expect(ada.status).toBe(200);
    // The stream is open once the first event can be heard: give Redis-less
    // channels a beat to register both readers.
    await Bun.sleep(100);

    const done = status("done");
    const { moveIssue } = await asOwner.call<{
      moveIssue: { statusId: string; rank: string };
    }>(MoveIssue, { id: created.id, statusId: done });

    for (const client of [ada, bob]) {
      const event = (await client.next())?.data?.projectBoard;
      expect(event).toMatchObject({
        verb: "moved",
        issueId: created.id,
        issueKey: "ABC-1",
        statusId: done,
        rank: moveIssue.rank,
      });
      expect(event?.fields).toContain("statusId");
    }
    // The event names the row the journal wrote.
    const [latest] = (await journal(asOwner, { projectId: project.id })).nodes;
    expect(latest?.verb).toBe("moved");
    await ada.close();
    await bob.close();
  });

  test("the board hears creates, updates and deletes, not comments; the issue hears its comments", async () => {
    const { asOwner, project, issue, owner, live } = await setup();
    const board = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    await Bun.sleep(100);
    const created = await issue("Live");
    const one = await live(owner.token)<IssueEvent>(IssueLive, {
      issueId: created.id,
    });
    await Bun.sleep(100);
    await asOwner.call(UpdateIssue, {
      id: created.id,
      input: { title: "Live too" },
    });
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: "Hi" },
    });
    await asOwner.call(DeleteIssue, { id: created.id });

    expect((await board.next())?.data?.projectBoard.verb).toBe("created");
    expect((await board.next())?.data?.projectBoard.verb).toBe("updated");
    expect((await board.next())?.data?.projectBoard.verb).toBe("deleted");
    expect(await board.quiet()).toBe(true);

    expect((await one.next())?.data?.issueChanged.verb).toBe("updated");
    expect((await one.next())?.data?.issueChanged.verb).toBe("commented");
    expect((await one.next())?.data?.issueChanged.verb).toBe("deleted");
    await board.close();
    await one.close();
  });

  test("a refused write publishes nothing", async () => {
    const { asOwner, project, issue, status, owner, live } = await setup();
    const created = await issue();
    const board = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    await Bun.sleep(100);
    const refused = await asOwner.attempt(MoveIssue, {
      id: created.id,
      statusId: status("done"),
      afterId: created.id,
    });
    expect(refused.errors).toBeDefined();
    expect(await board.quiet()).toBe(true);
    await board.close();
  });
});

describe("who may subscribe", () => {
  test("a viewer reads the board; anonymous, a stranger and a wrong organisation are refused", async () => {
    const { project, viewer, live, issue } = await setup();
    const created = await issue();
    const ok = await live(viewer.token)(Board, { projectId: project.id });
    expect(ok.status).toBe(200);
    expect((await ok.next(300))?.errors).toBeUndefined();
    await ok.close();

    const anonymous = await live(null)(Board, { projectId: project.id });
    expect(codeOf((await anonymous.next()) ?? {})).toBe(
      "auth.errors.unauthenticated",
    );
    await anonymous.close();

    // An account of another organisation is no member of this one.
    const other = await ownerWithOrganisation(kit, "Other");
    const stranger = await live(other.owner.token)(IssueLive, {
      issueId: created.id,
    });
    expect(codeOf((await stranger.next()) ?? {})).toBe(
      "tenancy.errors.unknown-organization",
    );
    await stranger.close();

    const noOrg = await live(viewer.token, null)(Board, {
      projectId: project.id,
    });
    expect(codeOf((await noOrg.next()) ?? {})).toBe(
      "tenancy.errors.organization-required",
    );
    await noOrg.close();
  });

  test("a project or issue of another organisation is unknown, not forbidden", async () => {
    const { owner, live } = await setup();
    const other = await ownerWithOrganisation(kit, "Elsewhere");
    const { createProject: otherProject } = await kit
      .client(other.owner.token, { organisation: other.organisation.id })
      .call<{ createProject: { id: string } }>(CreateProject, {
        input: { key: "XYZ", name: "Zed" },
      });
    const foreign = await live(owner.token)(Board, {
      projectId: otherProject.id,
    });
    expect(codeOf((await foreign.next()) ?? {})).toBe(
      "projects.errors.not-found",
    );
    await foreign.close();
    const malformed = await live(owner.token)(IssueLive, { issueId: "nope" });
    expect(codeOf((await malformed.next()) ?? {})).toBe(
      "validation.errors.invalid-input",
    );
    await malformed.close();
  });

  test("intake reports need the right to write issues; notifications are the viewer's own", async () => {
    const { project, viewer, member, live } = await setup();
    const refused = await live(viewer.token)(Reports, {
      projectId: project.id,
    });
    expect(codeOf((await refused.next()) ?? {})).toBe("auth.errors.forbidden");
    await refused.close();

    const allowed = await live(member.token)(Reports, {
      projectId: project.id,
    });
    expect((await allowed.next(300))?.errors).toBeUndefined();
    await allowed.close();

    const own = await live(viewer.token)(Notifications);
    expect((await own.next(300))?.errors).toBeUndefined();
    await own.close();
    const anonymous = await live(null)(Notifications);
    expect(codeOf((await anonymous.next()) ?? {})).toBe(
      "auth.errors.unauthenticated",
    );
    await anonymous.close();
  });
});

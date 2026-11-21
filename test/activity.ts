import { type AuthApp, memberWith, ownerWithOrganisation } from "~/auth";
import { subscribe } from "~/sse";

export const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id statuses { id category } }
}`;
export const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key statusId }
}`;
export const UpdateIssue = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id }
}`;
export const MoveIssue = `mutation($id: ID!, $statusId: ID!, $beforeId: ID, $afterId: ID) {
  moveIssue(id: $id, statusId: $statusId, beforeId: $beforeId, afterId: $afterId) { id statusId rank }
}`;
export const DeleteIssue = `mutation($id: ID!) { deleteIssue(id: $id) }`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const Activity = `query($projectId: ID, $issueId: ID, $first: Int, $after: String) {
  activity(projectId: $projectId, issueId: $issueId, first: $first, after: $after) {
    nodes { id projectId issueId issueKey actorId verb changes { field from to } at }
    endCursor hasNextPage
  }
}`;
export const Board = `subscription($projectId: ID!) {
  projectBoard(projectId: $projectId) {
    activityId verb projectId issueId issueKey actorId fields statusId rank at
  }
}`;
export const IssueLive = `subscription($issueId: ID!) {
  issueChanged(issueId: $issueId) { activityId verb issueId issueKey fields }
}`;
export const ChangeRole = `mutation($id: ID!, $role: Role!) {
  changeMemberRole(id: $id, role: $role) { id }
}`;
export const Notifications = `subscription { notificationReceived { notificationId kind unreadCount } }`;
export const Reports = `subscription($projectId: ID!) {
  clientReportReceived(projectId: $projectId) { reportId title at }
}`;

export interface Event {
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
export interface IssueEvent {
  issueChanged: { verb: string; issueId: string; fields: string[] };
}
export interface Row {
  verb: string;
  issueId: string | null;
  issueKey: string | null;
  actorId: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

export async function setup(kit: AuthApp) {
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

export const journal = async (
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

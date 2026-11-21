import { type AuthApp, memberWith, ownerWithOrganisation } from "~/auth";
import { subscribe } from "~/sse";

export const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
export const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key }
}`;
export const UpdateIssue = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id }
}`;
export const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
export const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
export const EditComment = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { id }
}`;
export const List = `query($unread: Boolean, $first: Int, $after: String) {
  notifications(unread: $unread, first: $first, after: $after) {
    nodes { id kind activityId issueKey issueTitle actorId commentId readAt }
    endCursor hasNextPage
  }
}`;
export const Count = `query { unreadNotificationCount }`;
export const MarkRead = `mutation($ids: [ID!]) { markNotificationsRead(ids: $ids) }`;
export const Live = `subscription { notificationReceived { notificationId kind unreadCount } }`;

export interface Row {
  id: string;
  kind: string;
  activityId: string;
  issueKey: string;
  issueTitle: string;
  actorId: string;
  commentId: string | null;
  readAt: string | null;
}

export const mention = (id: string, label = "x") => `Hello @[${label}](${id})`;

export async function setup(kit: AuthApp) {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const issue = async (title = "An issue", assigneeId?: string) =>
    (
      await asOwner.call<{ createIssue: { id: string; key: string } }>(
        CreateIssue,
        { input: { projectId: project.id, title, assigneeId } },
      )
    ).createIssue;
  const ada = await memberWith(kit, organisation.id, owner.token, "member");
  const bob = await memberWith(kit, organisation.id, owner.token, "member");
  const inbox = async (token: string, unread = false) =>
    (
      await as(token).call<{
        notifications: { nodes: Row[]; endCursor: string | null };
      }>(List, { unread })
    ).notifications.nodes;
  const live = (token: string) =>
    subscribe<{
      notificationReceived: {
        notificationId: string;
        kind: string;
        unreadCount: number;
      };
    }>(kit, token, { organisation: organisation.id }, Live);
  return {
    owner,
    organisation,
    project,
    asOwner,
    as,
    issue,
    ada,
    bob,
    inbox,
    live,
  };
}

import { type AuthApp, memberWith, ownerWithOrganisation } from "~/auth";

export const fields = `id issueId authorId body mentionIds public editedAt`;
export const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
export const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key }
}`;
export const DeleteIssue = `mutation($id: ID!) { deleteIssue(id: $id) }`;
export const Add = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { ${fields} }
}`;
export const Edit = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { ${fields} }
}`;
export const Delete = `mutation($id: ID!) { deleteComment(id: $id) }`;
export const List = `query($issueId: ID!, $first: Int, $after: String) {
  comments(issueId: $issueId, first: $first, after: $after) {
    nodes { ${fields} } endCursor hasNextPage
  }
}`;

export interface Comment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  mentionIds: string[];
  public: boolean;
  editedAt: string | null;
}
export interface Listing {
  comments: {
    nodes: Comment[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

export async function setup(kit: AuthApp) {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const { createIssue: issue } = await asOwner.call<{
    createIssue: { id: string };
  }>(CreateIssue, { input: { projectId: project.id, title: "An issue" } });
  const member = await memberWith(kit, organisation.id, owner.token, "member");
  const admin = await memberWith(kit, organisation.id, owner.token, "admin");
  const viewer = await memberWith(kit, organisation.id, owner.token, "viewer");
  return {
    owner,
    organisation,
    asOwner,
    issue,
    member,
    admin,
    viewer,
    asMember: as(member.token),
    asAdmin: as(admin.token),
    asViewer: as(viewer.token),
    as,
  };
}

export const comment = async (
  client: { call: <T>(q: string, v?: Record<string, unknown>) => Promise<T> },
  issueId: string,
  body: string,
  extra: Record<string, unknown> = {},
) =>
  (
    await client.call<{ addComment: Comment }>(Add, {
      issueId,
      input: { body, ...extra },
    })
  ).addComment;

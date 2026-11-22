import { authApp, ownerWithOrganisation } from "~/auth";

export const kit = authApp();

export const fields = `id projectId number key title description statusId priority
  assigneeId labelIds parentId startDate dueDate rank reporterId watcherIds
  watching type progress { done total }`;
export const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id key statuses { id name category } }
}`;
export const CreateLabel = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { id }
}`;
export const DeleteLabel = `mutation($id: ID!) { deleteLabel(id: $id) }`;
export const DeleteStatus = `mutation($id: ID!) { deleteStatus(id: $id) }`;
export const Create = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { ${fields} }
}`;
export const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { ${fields} }
}`;
export const Move = `mutation($id: ID!, $statusId: ID!, $beforeId: ID, $afterId: ID) {
  moveIssue(id: $id, statusId: $statusId, beforeId: $beforeId, afterId: $afterId) { ${fields} }
}`;
export const Delete = `mutation($id: ID!) { deleteIssue(id: $id) }`;
export const Watch = `mutation($id: ID!) { watchIssue(id: $id) { watcherIds watching } }`;
export const Unwatch = `mutation($id: ID!) { unwatchIssue(id: $id) { watcherIds watching } }`;
export const ByKey = `query($key: String!) { issue(key: $key) { ${fields} } }`;
export const List = `query($projectId: ID!, $filter: IssueFilter, $sort: IssueSort, $first: Int, $after: String) {
  issues(projectId: $projectId, filter: $filter, sort: $sort, first: $first, after: $after) {
    nodes { id key title rank } endCursor hasNextPage
  }
}`;

export interface Issue {
  id: string;
  key: string;
  number: number;
  title: string;
  statusId: string;
  rank: string;
  labelIds: string[];
  parentId: string | null;
  assigneeId: string | null;
  reporterId: string | null;
  priority: string;
  dueDate: string | null;
  startDate: string | null;
  watcherIds: string[];
  watching: boolean;
  type: "epic" | "story" | "task" | "bug" | "subTask";
  progress: { done: number; total: number };
}
export interface Project {
  id: string;
  key: string;
  statuses: { id: string; name: string; category: string }[];
}
export interface Listing {
  issues: {
    nodes: { id: string; key: string; title: string }[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

export async function withProject(key = "ABC") {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: Project;
  }>(CreateProject, { input: { key, name: "Alpha" } });
  const [triage, backlog, todo, inProgress, done] = project.statuses.map(
    (s) => s.id,
  ) as [string, string, string, string, string];
  const make = async (title: string, extra: Record<string, unknown> = {}) =>
    (
      await asOwner.call<{ createIssue: Issue }>(Create, {
        input: { projectId: project.id, title, ...extra },
      })
    ).createIssue;
  const titles = async (
    filter?: Record<string, unknown>,
    sort?: Record<string, unknown>,
  ) =>
    (
      await asOwner.call<Listing>(List, {
        projectId: project.id,
        filter,
        sort,
      })
    ).issues.nodes.map((n) => n.title);
  return {
    owner,
    organisation,
    asOwner,
    project,
    triage,
    backlog,
    todo,
    inProgress,
    done,
    make,
    titles,
  };
}

export async function listingFixture() {
  const t = await withProject();
  const label = await t.asOwner.call<{ createLabel: { id: string } }>(
    CreateLabel,
    { input: { projectId: t.project.id, name: "bug", colour: "#ff0000" } },
  );
  const lid = label.createLabel.id;
  const a = await t.make("Alpha login", {
    type: "epic",
    priority: "low",
    assigneeId: t.owner.id,
    labelIds: [lid],
    dueDate: "2026-03-10T00:00:00Z",
  });
  await t.make("Beta export", {
    priority: "urgent",
    statusId: t.todo,
    dueDate: "2026-03-01T00:00:00Z",
  });
  await t.make("Gamma [x]", {
    priority: "high",
    statusId: t.done,
    parentId: a.id,
  });
  await t.make("Delta", {});
  await t.asOwner.call(Watch, { id: a.id });
  return { t, lid, a };
}

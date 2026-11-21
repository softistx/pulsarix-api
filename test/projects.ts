import { type AuthApp, ownerWithOrganisation } from "~/auth";

export const projectFields = `id key name description leadId archivedAt
  statuses { id name category order colour } labels { id name colour }`;
export const Create = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { ${projectFields} }
}`;
export const Update = `mutation($id: ID!, $input: UpdateProjectInput!) {
  updateProject(id: $id, input: $input) { id name description leadId }
}`;
export const Archive = `mutation($id: ID!) { archiveProject(id: $id) { id archivedAt } }`;
export const Unarchive = `mutation($id: ID!) { unarchiveProject(id: $id) { id archivedAt } }`;
export const List = `query($all: Boolean) { projects(includeArchived: $all) { key } }`;
export const ByKey = `query($key: String!) { project(key: $key) { ${projectFields} } }`;
export const CreateStatus = `mutation($input: CreateStatusInput!) {
  createStatus(input: $input) { id name order category }
}`;
export const UpdateStatus = `mutation($id: ID!, $input: UpdateStatusInput!) {
  updateStatus(id: $id, input: $input) { id name category colour }
}`;
export const Reorder = `mutation($projectId: ID!, $ids: [ID!]!) {
  reorderStatuses(projectId: $projectId, ids: $ids) { id name order }
}`;
export const DeleteStatus = `mutation($id: ID!) { deleteStatus(id: $id) }`;
export const CreateLabel = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { id name colour }
}`;
export const UpdateLabel = `mutation($id: ID!, $input: UpdateLabelInput!) {
  updateLabel(id: $id, input: $input) { id name colour }
}`;
export const DeleteLabel = `mutation($id: ID!) { deleteLabel(id: $id) }`;

export interface Project {
  id: string;
  key: string;
  statuses: { id: string; name: string; category: string; order: number }[];
  labels: { id: string; name: string }[];
}

// An organisation with its owner's client, and a project made in it.
export async function withProject(kit: AuthApp, key = "ABC") {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: Project;
  }>(Create, { input: { key, name: "Alpha" } });
  return { owner, organisation, asOwner, project };
}

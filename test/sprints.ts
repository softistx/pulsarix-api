import { type Issue, withProject } from "~/issues";

export const sprintFields = `id projectId number name goal state startDate endDate
  closedAt committedPoints completedPoints`;
export const UpdateProject = `mutation($id: ID!, $input: UpdateProjectInput!) {
  updateProject(id: $id, input: $input) { id sprintsEnabled sprintLengthWeeks }
}`;
export const CreateSprint = `mutation($projectId: ID!, $input: CreateSprintInput!) {
  createSprint(projectId: $projectId, input: $input) { ${sprintFields} }
}`;
export const UpdateSprint = `mutation($id: ID!, $input: UpdateSprintInput!) {
  updateSprint(id: $id, input: $input) { ${sprintFields} }
}`;
export const DeleteSprint = `mutation($id: ID!) { deleteSprint(id: $id) }`;
export const StartSprint = `mutation($id: ID!, $input: StartSprintInput!) {
  startSprint(id: $id, input: $input) { ${sprintFields} }
}`;
export const CloseSprint = `mutation($id: ID!, $input: CloseSprintInput!) {
  closeSprint(id: $id, input: $input) { ${sprintFields} }
}`;
export const PlanIssues = `mutation($ids: [ID!]!, $sprintId: ID, $afterId: ID, $beforeId: ID) {
  planIssues(ids: $ids, sprintId: $sprintId, afterId: $afterId, beforeId: $beforeId) {
    id title sprintId planRank
  }
}`;
export const Sprints = `query($projectId: ID!, $states: [SprintState!]) {
  sprints(projectId: $projectId, states: $states) { ${sprintFields} }
}`;

export interface Sprint {
  id: string;
  projectId: string;
  number: number;
  name: string;
  goal: string | null;
  state: "planned" | "active" | "closed";
  startDate: string | null;
  endDate: string | null;
  closedAt: string | null;
  committedPoints: number;
  completedPoints: number;
}
export interface Planned {
  id: string;
  title: string;
  sprintId: string | null;
  planRank: string;
}

// A project with sprints turned on, and the calls the specs make.
export async function withSprints(key = "SPR") {
  const t = await withProject(key);
  await t.asOwner.call(UpdateProject, {
    id: t.project.id,
    input: { sprintsEnabled: true },
  });
  const sprint = async (input: Record<string, unknown> = {}) =>
    (
      await t.asOwner.call<{ createSprint: Sprint }>(CreateSprint, {
        projectId: t.project.id,
        input,
      })
    ).createSprint;
  const plan = async (
    issues: Pick<Issue, "id">[],
    sprintId: string | null,
    placement: { afterId?: string; beforeId?: string } = {},
  ) =>
    (
      await t.asOwner.call<{ planIssues: Planned[] }>(PlanIssues, {
        ids: issues.map((issue) => issue.id),
        sprintId,
        ...placement,
      })
    ).planIssues;
  const start = async (id: string, input: Record<string, unknown> = {}) =>
    (
      await t.asOwner.call<{ startSprint: Sprint }>(StartSprint, {
        id,
        input: { startDate: "2026-03-02T00:00:00Z", ...input },
      })
    ).startSprint;
  const close = async (
    id: string,
    input: Record<string, unknown> = { unfinished: "NEXT_SPRINT" },
  ) =>
    (await t.asOwner.call<{ closeSprint: Sprint }>(CloseSprint, { id, input }))
      .closeSprint;
  const all = async (states?: string[]) =>
    (
      await t.asOwner.call<{ sprints: Sprint[] }>(Sprints, {
        projectId: t.project.id,
        states,
      })
    ).sprints;
  return { ...t, sprint, plan, start, close, all };
}

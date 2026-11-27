import type { Resolvers } from "@/generated/graphql/resolvers";
import { dataLoaders } from "../data-loaders";
import { scoped } from "./sprints.resolver-support";

export const sprintsResolvers: Resolvers = {
  Query: {
    sprints: async (_, { projectId, states }, ctx) =>
      (await scoped(ctx, "sprint:read")).sprints.list(projectId, states),
    sprintBurndown: async (_, { id }, ctx) =>
      (await scoped(ctx, "sprint:read")).reports.burndown(id, new Date()),
    velocity: async (_, { projectId, last }, ctx) =>
      (await scoped(ctx, "sprint:read")).reports.velocity(projectId, last),
  },
  Mutation: {
    createSprint: async (_, { projectId, input }, ctx) =>
      (await scoped(ctx, "sprint:write")).sprints.create(projectId, input),
    updateSprint: async (_, { id, input, projectId }, ctx) =>
      (await scoped(ctx, "sprint:write")).sprints.update(id, input, projectId),
    deleteSprint: async (_, { id, projectId }, ctx) =>
      (await scoped(ctx, "sprint:write")).sprints.delete(id, projectId),
    startSprint: async (_, { id, input, projectId }, ctx) =>
      (await scoped(ctx, "sprint:write")).lifecycle.start(id, input, projectId),
    closeSprint: async (_, { id, input, projectId }, ctx) =>
      (await scoped(ctx, "sprint:write")).lifecycle.close(id, input, projectId),
    planIssues: async (_, input, ctx) =>
      (await scoped(ctx, "sprint:write")).planning.plan(input),
  },
  Sprint: {
    id: (sprint) => sprint.id,
    projectId: (sprint) => sprint.projectId.toHexString(),
    progress: (sprint, _, ctx) =>
      dataLoaders(ctx).sprints.progress.load(sprint.id),
  },
};

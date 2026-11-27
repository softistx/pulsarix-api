import type { Resolvers } from "@/generated/graphql/resolvers";
import { scoped } from "./sprints.resolver-support";

export const sprintsResolvers: Resolvers = {
  Query: {
    sprints: async (_, { projectId, states }, ctx) =>
      (await scoped(ctx, "sprint:read")).sprints.list(projectId, states),
  },
  Mutation: {
    createSprint: async (_, { projectId, input }, ctx) =>
      (await scoped(ctx, "sprint:write")).sprints.create(projectId, input),
    updateSprint: async (_, { id, input }, ctx) =>
      (await scoped(ctx, "sprint:write")).sprints.update(id, input),
    deleteSprint: async (_, { id }, ctx) =>
      (await scoped(ctx, "sprint:write")).sprints.delete(id),
    startSprint: async (_, { id, input }, ctx) =>
      (await scoped(ctx, "sprint:write")).lifecycle.start(id, input),
    closeSprint: async (_, { id, input }, ctx) =>
      (await scoped(ctx, "sprint:write")).lifecycle.close(id, input),
    planIssues: async (_, input, ctx) =>
      (await scoped(ctx, "sprint:write")).planning.plan(input),
  },
  Sprint: {
    id: (sprint) => sprint.id,
    projectId: (sprint) => sprint.projectId.toHexString(),
  },
};

import type { Resolvers } from "@/generated/graphql/resolvers";
import { dataLoaders } from "../data-loaders";
import { publicStateOfStatus } from "./projects.model";
import { manager, reader } from "./projects.resolver-support";

export const projectsResolvers: Resolvers = {
  Query: {
    projects: async (_, { includeArchived }, ctx) =>
      (await reader(ctx)).projects.list(includeArchived ?? false),
    project: async (_, { key }, ctx) => (await reader(ctx)).projects.byKey(key),
  },
  Mutation: {
    createProject: async (_, { input }, ctx) =>
      (await manager(ctx)).projects.create(input),
    updateProject: async (_, { id, input }, ctx) =>
      (await manager(ctx)).projects.update(id, input),
    archiveProject: async (_, { id }, ctx) =>
      (await manager(ctx)).projects.setArchived(id, true),
    unarchiveProject: async (_, { id }, ctx) =>
      (await manager(ctx)).projects.setArchived(id, false),
    createStatus: async (_, { input }, ctx) =>
      (await manager(ctx)).statuses.create(input),
    updateStatus: async (_, { id, input }, ctx) =>
      (await manager(ctx)).statuses.update(id, input),
    reorderStatuses: async (_, { projectId, ids }, ctx) =>
      (await manager(ctx)).statuses.reorder(projectId, ids),
    deleteStatus: async (_, { id }, ctx) =>
      (await manager(ctx)).statuses.delete(id),
    createLabel: async (_, { input }, ctx) =>
      (await manager(ctx)).labels.create(input),
    updateLabel: async (_, { id, input }, ctx) =>
      (await manager(ctx)).labels.update(id, input),
    deleteLabel: async (_, { id }, ctx) =>
      (await manager(ctx)).labels.delete(id),
  },
  Project: {
    id: (project) => project.id,
    statuses: (project, _, ctx) =>
      dataLoaders(ctx).projects.statuses.load(project.id),
    labels: (project, _, ctx) =>
      dataLoaders(ctx).projects.labels.load(project.id),
  },
  Status: {
    id: (status) => status.id,
    projectId: (status) => status.projectId.toHexString(),
    publicState: (status) => publicStateOfStatus(status),
  },
  Label: {
    id: (label) => label.id,
    projectId: (label) => label.projectId.toHexString(),
  },
};

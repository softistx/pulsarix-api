import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireViewer } from "../../core/access";
import { dataLoaders } from "../data-loaders";
import { planRankOf, typeOf } from "./issues.model";
import { listIssues } from "./issues.query";
import { scoped } from "./issues.resolver-support";

export const issuesResolvers: Resolvers = {
  Query: {
    issues: async (_, args, ctx) => {
      const { mongo, viewerId } = await scoped(ctx, "issue:read");
      return listIssues(mongo, viewerId, args as never);
    },
    issue: async (_, { key }, ctx) =>
      (await scoped(ctx, "issue:read")).issues.byKey(key),
    roadmap: async (_, { projectId }, ctx) =>
      (await scoped(ctx, "issue:read")).roadmap.of(projectId),
  },
  Mutation: {
    createIssue: async (_, { input }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.create(input),
    updateIssue: async (_, { id, input, projectId }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.update(id, input, projectId),
    updateIssues: async (_, { ids, input }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.bulkUpdate(ids, input),
    moveIssue: async (_, { id, statusId, beforeId, afterId, projectId }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.move(
        id,
        statusId,
        beforeId,
        afterId,
        projectId,
      ),
    deleteIssue: async (_, { id }, ctx) =>
      (await scoped(ctx, "issue:delete")).issues.delete(id),
    watchIssue: async (_, { id }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.setWatching(id, true),
    unwatchIssue: async (_, { id }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.setWatching(id, false),
  },
  Issue: {
    id: (issue) => issue.id,
    projectId: (issue) => issue.projectId.toHexString(),
    statusId: (issue) => issue.statusId.toHexString(),
    type: (issue) => typeOf(issue),
    sprintId: (issue) => issue.sprintId?.toHexString() ?? null,
    planRank: (issue) => planRankOf(issue),
    progress: (issue, _, ctx) =>
      dataLoaders(ctx).issues.progress.load(issue.id),
    priorityOrigin: (issue) => issue.priorityOrigin ?? "team",
    labelIds: (issue) => issue.labelIds.map((id) => id.toHexString()),
    parentId: (issue) => issue.parentId?.toHexString() ?? null,
    clientReportId: (issue) => issue.clientReportId?.toHexString() ?? null,
    // Issues stored before widget v3 lack the flag.
    clientWaiting: (issue) => issue.clientWaiting === true,
    clientMarkers: (issue) => issue.clientMarkers ?? [],
    watching: (issue, _, ctx) =>
      issue.watcherIds.includes(requireViewer(ctx).id),
  },
};

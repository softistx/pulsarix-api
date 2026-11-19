import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { listIssues } from "./issues.query";
import { IssuesService } from "./issues.service";

type Permission = "issue:read" | "issue:write" | "issue:delete";

// The service of the request's organisation, once the guard let the viewer in.
async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewerId = requireViewer(ctx).id;
  return {
    viewerId,
    mongo,
    issues: new IssuesService(
      mongo,
      async (accountId) =>
        (await ctx.services.roleOf(tenant._id.toHexString(), accountId)) !==
        null,
      viewerId,
      tenant._id.toHexString(),
    ),
  };
}

export const issuesResolvers: Resolvers = {
  Query: {
    issues: async (_, args, ctx) => {
      const { mongo, viewerId } = await scoped(ctx, "issue:read");
      return listIssues(mongo, viewerId, args as never);
    },
    issue: async (_, { key }, ctx) =>
      (await scoped(ctx, "issue:read")).issues.byKey(key),
  },
  Mutation: {
    createIssue: async (_, { input }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.create(input),
    updateIssue: async (_, { id, input }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.update(id, input),
    updateIssues: async (_, { ids, input }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.bulkUpdate(ids, input),
    moveIssue: async (_, { id, statusId, beforeId, afterId }, ctx) =>
      (await scoped(ctx, "issue:write")).issues.move(
        id,
        statusId,
        beforeId,
        afterId,
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

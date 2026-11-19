import type { Resolvers } from "@/generated/graphql/resolvers";
import { can, requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { CommentsService } from "./comments.service";
import { isClientEntry } from "./comments.sources";

type Permission = "comment:read" | "comment:write";

// The service of the request's organisation, once the guard let the viewer in.
// An admin or an owner (`comment:delete`) may change others' comments.
async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewer = requireViewer(ctx);
  const organisationId = tenant._id.toHexString();
  return new CommentsService(
    mongo,
    async (accountId) =>
      (await ctx.services.roleOf(organisationId, accountId)) !== null,
    viewer.id,
    await can(ctx, "comment:delete"),
    organisationId,
  );
}

export const commentsResolvers: Resolvers = {
  Query: {
    comments: async (_, { issueId, first, after }, ctx) =>
      (await scoped(ctx, "comment:read")).list(issueId, first, after),
  },
  Mutation: {
    addComment: async (_, { issueId, input }, ctx) =>
      (await scoped(ctx, "comment:write")).add(issueId, input),
    editComment: async (_, { id, input }, ctx) =>
      (await scoped(ctx, "comment:write")).edit(id, input),
    deleteComment: async (_, { id }, ctx) =>
      (await scoped(ctx, "comment:write")).delete(id),
  },
  Comment: {
    id: (comment) => comment.id,
    issueId: (comment) => comment.issueId.toHexString(),
    source: (comment) => (isClientEntry(comment) ? "CLIENT" : "TEAM"),
    reportId: (comment) => (isClientEntry(comment) ? comment.reportId : null),
    reporterName: (comment) =>
      isClientEntry(comment) ? comment.reporterName : null,
  },
};

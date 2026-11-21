import type { Resolvers } from "@/generated/graphql/resolvers";
import { scoped } from "./comments.resolver-support";
import { isClientEntry } from "./comments.sources";

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

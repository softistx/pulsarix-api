import type { Resolvers } from "@/generated/graphql/resolvers";
import { previewSize } from "./attachments.kinds";
import { scoped } from "./attachments.resolver-support";
import { urlOf } from "./attachments.utils";

export const attachmentsResolvers: Resolvers = {
  Query: {
    attachments: async (_, { ownerType, ownerId }, ctx) =>
      (await scoped(ctx, "attachment:read")).list(ownerType, ownerId),
    issueAttachments: async (_, { issueId }, ctx) =>
      (await scoped(ctx, "attachment:read")).listForIssue(issueId),
  },
  Mutation: {
    deleteAttachment: async (_, { id }, ctx) =>
      (await scoped(ctx, "attachment:write")).delete(id),
  },
  Attachment: {
    id: (attachment) => attachment.id,
    ownerId: (attachment) => attachment.ownerId.toHexString(),
    issueId: (attachment) => attachment.issueId.toHexString(),
    url: (attachment) => urlOf(attachment.storageKey),
    previewUrl: (attachment) =>
      attachment.previewKey
        ? `${urlOf(attachment.storageKey)}/${previewSize}`
        : null,
  },
};

import type { Resolvers } from "@/generated/graphql/resolvers";
import { can, requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { kindName, previewSize } from "./attachments.kinds";
import { AttachmentsService } from "./attachments.service";

type Permission = "attachment:read" | "attachment:write";

async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewer = requireViewer(ctx);
  return new AttachmentsService(
    mongo,
    viewer.id,
    await can(ctx, "attachment:delete"),
    tenant._id.toHexString(),
  );
}

const urlOf = (key: string) => `/media/${kindName}/${key}`;

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

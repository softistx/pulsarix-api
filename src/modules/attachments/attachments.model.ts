import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

export const ownerType = z.enum(["issue", "comment"]);
export type OwnerType = z.infer<typeof ownerType>;

// A file on an issue or on one of its comments, in the organisation's
// database. The bytes live in the private bucket under `storageKey` (the key
// the upload route answered, @softistx/alxia-media); `previewKey` names the thumbnail
// rendition stored beside it (an image's square), null when there is none (a
// PDF: see CONTEXT.md). `issueId` is the issue in both cases, so removing an
// issue finds the files of its comments too.
export const attachments = defineCollection({
  name: "attachments",
  schema: z.object({
    _id: id(),
    ownerType,
    ownerId: objectId(),
    issueId: objectId(),
    fileName: z.string().trim().min(1).max(200),
    mime: z.string().min(1).max(100),
    size: z.number().int().min(0),
    storageKey: z.uuid(),
    previewKey: z.string().min(1).max(20).nullable().default(null),
    uploadedBy: accountId,
  }),
  timestamps: true,
  actors,
  indexes: [
    {
      key: { ownerType: 1, ownerId: 1, _id: 1 },
      name: "attachments_ownerTypeOwnerIdId",
    },
    { key: { issueId: 1 }, name: "attachments_issueId" },
    {
      key: { storageKey: 1 },
      unique: true,
      name: "attachments_storageKeyUnique",
    },
  ],
});
export type AttachmentDocument = ReadDocumentOf<typeof attachments>;

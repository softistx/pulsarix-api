import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

// A comment on an issue, in the organisation's database. `body` is rich text
// kept as the client sends it, with its `@[Label](id)` mention markers;
// `mentionIds` are the members those markers named, checked on every write
// (the ids in a body are untrusted). `public` marks a reply the tracking page
// of a client report shows (plan Q9).
export const comments = defineCollection({
  name: "comments",
  schema: z.object({
    _id: id(),
    issueId: objectId(),
    authorId: accountId,
    body: z.string().trim().min(1).max(20_000),
    mentionIds: z.array(accountId).default([]),
    public: z.boolean().default(false),
    editedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [{ key: { issueId: 1, _id: 1 }, name: "comments_issueIdId" }],
});
export type CommentDocument = ReadDocumentOf<typeof comments>;

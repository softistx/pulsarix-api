import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

// Why a member is told, strongest first: a mention beats an assignment, which
// beats a change to an issue they watch; `clientReplied` (a reporter wrote in
// the thread of a client report of the issue) is told to its assignee and
// watchers.
export const notificationKind = z.enum([
  "mention",
  "assigned",
  "watchedChange",
  "clientReplied",
]);
export type NotificationKind = z.infer<typeof notificationKind>;

// A member's notification, in the organisation's database. One event gives one
// row per recipient: `dedupeKey` is `mention:<comment id>` for a mention (an
// edit that keeps a mention does not tell its member again) and
// `activity:<activity id>` for the rest, unique per recipient. The issue's key
// and title are copied so that the row reads after the issue is gone. `readAt`
// is when the member read it; `digestedAt` is when a mailed digest carried it.
export const notifications = defineCollection({
  name: "notifications",
  schema: z.object({
    _id: id(),
    recipientId: accountId,
    kind: notificationKind,
    activityId: objectId(),
    projectId: objectId(),
    issueId: objectId(),
    issueKey: z.string(),
    issueTitle: z.string(),
    actorId: accountId,
    commentId: objectId().nullable().default(null),
    dedupeKey: z.string(),
    readAt: z.date().nullable().default(null),
    digestedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  actors,
  indexes: [
    {
      key: { recipientId: 1, dedupeKey: 1 },
      unique: true,
      name: "notifications_recipientIdDedupeKeyUnique",
    },
    {
      key: { recipientId: 1, readAt: 1, _id: -1 },
      name: "notifications_inbox",
    },
  ],
});
export type NotificationDocument = ReadDocumentOf<typeof notifications>;

import { realtime } from "../../config/redis";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import type { ActivityRecorded } from "../activity/public";
import { scheduleDigest } from "./notifications.digest";
import type { NotificationKind } from "./notifications.model";
import { recipientsOf } from "./notifications.rules";
import type { NotificationsMongo } from "./notifications.service";

const TITLE_CLIP = 200;

// Turns a journalled change into notifications, inside the transaction that
// wrote it: one row per recipient the rules name, none for a recipient who has
// the row already (the same mention seen again on an edit). Answers the work
// for after the commit: one live event per new row, with the recipient's
// unread count, and the digest of each recipient.
export async function recordNotifications(
  mongo: NotificationsMongo,
  recorded: ActivityRecorded,
): Promise<AfterCommit | undefined> {
  const { activity, issue, comment, organisationId } = recorded;
  const recipients = recipientsOf({
    verb: activity.verb,
    actorId: activity.actorId,
    assigneeId: issue.assigneeId,
    watcherIds: issue.watcherIds,
    changes: recorded.changes,
    mentionIds: comment?.mentionIds ?? [],
  });
  if (recipients.size === 0) return undefined;

  const dedupeKey = (kind: NotificationKind) =>
    kind === "mention" && comment
      ? `mention:${comment.id}`
      : `activity:${activity.id}`;
  const wanted = [...recipients].map(([recipientId, kind]) => ({
    recipientId,
    kind,
    dedupeKey: dedupeKey(kind),
  }));
  // A concurrent transaction inserting the same row is a write conflict, which
  // the writer retries (retryWriteConflicts), and the retry finds the row here.
  const known = await mongo.db.notifications.findMany({
    filter: {
      $or: wanted.map(({ recipientId, dedupeKey }) => ({
        recipientId,
        dedupeKey,
      })),
    },
  });
  const seen = new Set(
    known.map((row) => `${row.recipientId}\n${row.dedupeKey}`),
  );
  const fresh = wanted.filter(
    ({ recipientId, dedupeKey }) => !seen.has(`${recipientId}\n${dedupeKey}`),
  );
  if (fresh.length === 0) return undefined;

  const created = await mongo.db.notifications.createMany(
    fresh.map(({ recipientId, kind, dedupeKey }) => ({
      recipientId,
      kind,
      dedupeKey,
      activityId: activity._id,
      projectId: issue.projectId,
      issueId: issue._id,
      issueKey: issue.key,
      issueTitle: issue.title.slice(0, TITLE_CLIP),
      actorId: activity.actorId,
      commentId: comment?._id ?? null,
    })),
  );
  // After the commit, each piece alone: the count is read from committed
  // state, so concurrent events do not publish a count lacking each other.
  return () =>
    runAfterCommit(
      created.map((row) => async () => {
        // The transaction's handle is closed by now: a fresh one.
        // (Imported here: loading the schema must not open MongoDB.)
        const { tenancy } = await import("../../config/db");
        const after = (await tenancy.databaseOf(
          organisationId,
        )) as unknown as NotificationsMongo;
        const unreadCount = await after.db.notifications.count({
          recipientId: row.recipientId,
          readAt: null,
        });
        await Promise.allSettled([
          realtime.channels.notificationReceived.publish({
            organisationId,
            memberId: row.recipientId,
            notificationId: row.id,
            kind: row.kind,
            unreadCount,
          }),
          scheduleDigest(organisationId, row.recipientId),
        ]);
      }),
    );
}

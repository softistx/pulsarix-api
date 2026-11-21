import { realtime } from "../../config/redis";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import { registerCommentChange } from "../comments/public";
import { registerIssueChange } from "../issues/public";
import { activityRecorded } from "./activity.usage";
import { eventOf } from "./activity.utils";
import { journalOnIssue, recordActivity } from "./services";

// An issue's change is journalled inside the writing transaction and
// published to the board and to the issue's topic once it has committed.
registerIssueChange(async (mongo, change) => {
  const { issue, organisationId } = change;
  const activity = await recordActivity(mongo, {
    projectId: issue.projectId,
    issueId: issue._id,
    issueKey: issue.key,
    actorId: change.actorId,
    verb: change.verb,
    changes: change.changes,
  });
  const event = eventOf(organisationId, activity, {
    statusId: issue.statusId.toHexString(),
    rank: issue.rank,
  });
  const downstream = await activityRecorded(mongo, {
    activity,
    organisationId,
    issue,
    comment: null,
    changes: change.changes,
  });
  // Each piece fails alone: a lost publish does not skip the notifications.
  const later: AfterCommit = () =>
    runAfterCommit([
      async () => {
        await Promise.all([
          realtime.channels.projectBoard.publish(event),
          realtime.channels.issueChanged.publish(event),
        ]);
      },
      ...downstream,
    ]);
  return later;
});

// A comment is journalled on its issue, and published to the issue's topic
// only (the board shows no comments).
registerCommentChange(
  async (mongo, { comment, actorId, organisationId, verb }) => {
    const issue = await mongo.db.issues.findById(comment.issueId);
    // The issue is going in the same transaction: its own deletion is journalled.
    if (!issue) return undefined;
    return journalOnIssue(mongo, {
      issue,
      organisationId,
      actorId,
      verb,
      comment,
    });
  },
);

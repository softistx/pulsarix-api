import { realtime } from "../../config/redis";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import { registerCommentChange } from "../comments/public";
import { registerIssueChange } from "../issues/public";
import type { IssueEventPayload } from "./activity.channels";
import type { ActivityDocument } from "./activity.model";
import { type ActivityMongo, recordActivity } from "./activity.service";
import { activityRecorded } from "./activity.usage";

// The issue events go out after the commit, from the row the journal wrote.
const eventOf = (
  organisationId: string,
  activity: ActivityDocument,
  issue: { statusId: string | null; rank: string | null },
): IssueEventPayload => ({
  organisationId,
  activityId: activity.id,
  verb: activity.verb,
  projectId: activity.projectId.toHexString(),
  issueId: activity.issueId?.toHexString() ?? "",
  issueKey: activity.issueKey ?? "",
  actorId: activity.actorId,
  fields: activity.changes.map((change) => change.field),
  statusId: issue.statusId,
  rank: issue.rank,
  at: activity.at.toISOString(),
});

// An issue's change is journalled inside the writing transaction and
// published to the board and to the issue's topic once it has committed.
registerIssueChange(async (mongo, change) => {
  const { issue, organisationId } = change;
  const activity = await recordActivity(mongo as unknown as ActivityMongo, {
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
  const downstream = await activityRecorded(mongo as unknown as ActivityMongo, {
    activity,
    organisationId,
    issue,
    comment: null,
    changes: change.changes,
  });
  const later: AfterCommit = async () => {
    await Promise.all([
      realtime.channels.projectBoard.publish(event),
      realtime.channels.issueChanged.publish(event),
    ]);
    await runAfterCommit(downstream);
  };
  return later;
});

// A comment is journalled on its issue, and published to the issue's topic
// only (the board shows no comments).
registerCommentChange(
  async (mongo, { comment, actorId, organisationId, verb }) => {
    const issue = await mongo.db.issues.findById(comment.issueId);
    // The issue is going in the same transaction: its own deletion is journalled.
    if (!issue) return undefined;
    const activity = await recordActivity(mongo as unknown as ActivityMongo, {
      projectId: issue.projectId,
      issueId: issue._id,
      issueKey: issue.key,
      actorId,
      verb,
      changes: [],
    });
    const event = eventOf(organisationId, activity, {
      statusId: null,
      rank: null,
    });
    const downstream = await activityRecorded(
      mongo as unknown as ActivityMongo,
      { activity, organisationId, issue, comment, changes: [] },
    );
    return async () => {
      await realtime.channels.issueChanged.publish(event);
      await runAfterCommit(downstream);
    };
  },
);

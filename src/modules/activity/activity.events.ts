import { realtime } from "../../config/redis";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import type { CommentDocument } from "../comments/public";
import type { IssueDocument } from "../issues/public";
import type { IssueEventPayload } from "./activity.channels";
import type { ActivityDocument, ActivityVerb } from "./activity.model";
import { type ActivityMongo, recordActivity } from "./activity.service";
import { activityRecorded } from "./activity.usage";

// The issue events go out after the commit, from the row the journal wrote.
export const eventOf = (
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

// A change that touches the issue's own topic only (the board shows no
// comments and no client replies): journalled inside the writing transaction,
// told to the notifications, published once it has committed.
export async function journalOnIssue(
  mongo: ActivityMongo,
  given: {
    issue: IssueDocument;
    organisationId: string;
    actorId: string;
    verb: ActivityVerb;
    comment: CommentDocument | null;
  },
): Promise<AfterCommit> {
  const { issue, organisationId, comment } = given;
  const activity = await recordActivity(mongo, {
    projectId: issue.projectId,
    issueId: issue._id,
    issueKey: issue.key,
    actorId: given.actorId,
    verb: given.verb,
    changes: [],
  });
  const event = eventOf(organisationId, activity, {
    statusId: null,
    rank: null,
  });
  const downstream = await activityRecorded(mongo, {
    activity,
    organisationId,
    issue,
    comment,
    changes: [],
  });
  return () =>
    runAfterCommit([
      () => realtime.channels.issueChanged.publish(event).then(() => {}),
      ...downstream,
    ]);
}

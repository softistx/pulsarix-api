import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { CommentChangeHandler } from "../comments/public";

// "The client is waiting" (plan §19, A16): a reporter's message sets it on the
// report and on its issue; a public reply of the team clears it. It is the
// team's signal that a reporter wrote last, nothing the reporter sees.

type WaitingMongo = ModuleMongo<"intake"> & ModuleMongo<"issues">;

// The issue's flag follows its reports: waiting while any report on it waits.
// Writes only when it changes, inside the caller's transaction.
export async function refreshIssueWaiting(
  mongo: WaitingMongo,
  issueId: ObjectId,
): Promise<void> {
  const issue = await mongo.db.issues.findById(issueId);
  if (!issue) return;
  const waiting = await mongo.db.clientReports.exists({
    issueId,
    clientWaiting: true,
  });
  if ((issue.clientWaiting === true) !== waiting) {
    await mongo.db.issues.update(issue._id, { clientWaiting: waiting });
  }
}

// A public comment answers every report on its issue whose reporter did not
// write after it (so a late edit of an old reply does not hide a newer
// message). Runs inside the comment's transaction (registered in module.ts).
export const clearClientWaiting: CommentChangeHandler = async (
  commentsMongo,
  change,
) => {
  const { comment, verb } = change;
  if (!comment.public || verb === "commentDeleted") return undefined;
  const mongo = commentsMongo as unknown as WaitingMongo;
  const waiting = await mongo.db.clientReports.findMany({
    filter: { issueId: comment.issueId, clientWaiting: true },
    limit: 1_000,
  });
  for (const report of waiting) {
    const newer = await mongo.db.clientReportMessages.exists({
      reportId: report._id,
      erasedAt: null,
      _id: { $gt: comment._id },
    });
    if (!newer) {
      await mongo.db.clientReports.update(report._id, { clientWaiting: false });
    }
  }
  if (waiting.length > 0) await refreshIssueWaiting(mongo, comment.issueId);
  return undefined;
};

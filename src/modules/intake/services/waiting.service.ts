import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import type { CommentChangeHandler } from "../../comments/public";
import type { ClientReportDocument } from "../models";
import { linkedIssueIds, reportsOfIssue } from "./linked-reports.service";

// "The client is waiting" (plan §19, A16): a reporter's message sets it on the
// report and on its issue; a public reply of the team clears it. It is the
// team's signal that a reporter wrote last, nothing the reporter sees.

type WaitingMongo = ModuleMongo<"intake"> & ModuleMongo<"issues">;

// Every issue a report is linked to follows it (A24): a reporter's message
// makes all of them wait, a reply or an erasure on one of them clears it.
export async function refreshLinkedIssuesWaiting(
  mongo: WaitingMongo,
  report: Pick<ClientReportDocument, "_id" | "id" | "issueId">,
): Promise<void> {
  const ids = (await linkedIssueIds(mongo, [report])).get(report.id) ?? [];
  for (const id of ids) await refreshIssueWaiting(mongo, id);
}

// The issue's flag follows its reports: waiting while any report on it waits.
// Writes only when it changes, inside the caller's transaction.
export async function refreshIssueWaiting(
  mongo: WaitingMongo,
  issueId: ObjectId,
): Promise<void> {
  const issue = await mongo.db.issues.findById(issueId);
  if (!issue) return;
  const waiting =
    (await reportsOfIssue(mongo, issueId, { clientWaiting: true })).length > 0;
  if ((issue.clientWaiting === true) !== waiting) {
    await mongo.db.issues.update(issue._id, { clientWaiting: waiting });
  }
}

// A public comment answers every report on its issue whose reporter did not
// write after it (so a late edit of an old reply does not hide a newer
// message). Runs inside the comment's transaction (registered in module.ts).
export const clearClientWaiting: CommentChangeHandler = async (
  mongo,
  change,
) => {
  const { comment, verb } = change;
  if (!comment.public || verb === "commentDeleted") return undefined;
  const waiting = await reportsOfIssue(mongo, comment.issueId, {
    clientWaiting: true,
  });
  for (const report of waiting) {
    const newer = await mongo.db.clientReportMessages.exists({
      reportId: report._id,
      side: { $ne: "team" },
      erasedAt: null,
      _id: { $gt: comment._id },
    });
    if (!newer) {
      await mongo.db.clientReports.update(report._id, { clientWaiting: false });
    }
  }
  for (const report of waiting) await refreshLinkedIssuesWaiting(mongo, report);
  return undefined;
};

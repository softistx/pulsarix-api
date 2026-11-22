import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { CommentChangeHandler } from "../comments/public";
import type { IssueChangeHandler } from "../issues/public";
import { announceChanged } from "./intake.live";
import { reportsOfIssue } from "./services/linked-reports.service";

// What the team does that a reporter's open stream must hear (plan §19, A17):
// a public reply on the issue of their request (added, edited, withdrawn or
// deleted), and any move, edit or deletion
// of that issue (its status gives the request's public state). They run in the
// team's own transaction and answer the event to publish once it committed.
// Registered in module.ts.

async function announceIssue(
  mongo: ModuleMongo<"intake">,
  issueId: ObjectId,
  organisationId: string,
) {
  const reports = await reportsOfIssue(mongo, issueId, {
    reporterKey: { $ne: null },
  });
  return reports.length > 0
    ? announceChanged(organisationId, reports)
    : undefined;
}

export const announcePublicReply: CommentChangeHandler = async (
  mongo,
  { comment, previous, organisationId },
) => {
  // A reporter saw the comment when it is public now, was public before (a
  // reply switched to internal) or is the public one just deleted (`comment`
  // is then as it was).
  if (!comment.public && !previous?.public) return undefined;
  return announceIssue(mongo, comment.issueId, organisationId);
};

export const announceIssueChange: IssueChangeHandler = async (
  mongo,
  { verb, issue, organisationId },
) => {
  if (verb === "created") return undefined;
  return announceIssue(mongo, issue._id, organisationId);
};

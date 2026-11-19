import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { CommentChangeHandler } from "../comments/public";
import type { IssueChangeHandler } from "../issues/public";
import { announceChanged } from "./intake.live";

// What the team does that a reporter's open stream must hear (plan §19, A17):
// a public reply on the issue of their request, and any move, edit or deletion
// of that issue (its status gives the request's public state). They run in the
// team's own transaction and answer the event to publish once it committed.
// Registered in module.ts.

async function announceIssue(
  mongo: ModuleMongo<"intake">,
  issueId: ObjectId,
  organisationId: string,
) {
  const reports = await mongo.db.clientReports.findMany({
    filter: { issueId, reporterKey: { $ne: null } },
    limit: 100,
  });
  return reports.length > 0
    ? announceChanged(organisationId, reports)
    : undefined;
}

export const announcePublicReply: CommentChangeHandler = async (
  mongo,
  { comment, verb, organisationId },
) => {
  if (!comment.public || verb === "commentDeleted") return undefined;
  return announceIssue(
    mongo as unknown as ModuleMongo<"intake">,
    comment.issueId,
    organisationId,
  );
};

export const announceIssueChange: IssueChangeHandler = async (
  mongo,
  { verb, issue, organisationId },
) => {
  if (verb === "created") return undefined;
  return announceIssue(
    mongo as unknown as ModuleMongo<"intake">,
    issue._id,
    organisationId,
  );
};

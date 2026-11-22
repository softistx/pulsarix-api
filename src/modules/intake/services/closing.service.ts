import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import type { IssueChange } from "../../issues/public";
import type { ClientReportDocument } from "../models";
import { linkedIssueIds, reportsOfIssue } from "./linked-reports.service";
import { refreshIssueWaiting } from "./waiting.service";

type ClosingMongo = ModuleMongo<"intake"> & ModuleMongo<"issues">;

// Whether an issue stands in a done or cancelled status.
export async function isSettled(
  mongo: ModuleMongo<"issues">,
  issue: IssueChange["issue"],
): Promise<boolean> {
  const status = await mongo.db.statuses.findById(issue.statusId);
  return status?.category === "done" || status?.category === "cancelled";
}

// A created issue gets its link at once (see `followIssue`).
async function linkCreated(
  tx: ClosingMongo,
  change: IssueChange,
): Promise<void> {
  // The issue and its link to the report are written together: a created issue
  // always has its link (`clientReportLinks`), and the report's `issueId`, the
  // deprecated first link, is set when it has none.
  const reportId = change.issue.clientReportId;
  if (reportId) {
    const issueId = change.issue._id;
    const linked = await tx.db.clientReportLinks.exists({
      reportId,
      issueId,
    });
    if (!linked) {
      await tx.db.clientReportLinks.create({
        reportId,
        issueId,
        linkedAt: new Date(),
        linkedBy: change.actorId,
      });
    }
    const current = await tx.db.clientReports.findById(reportId);
    const report = current?.issueId
      ? current
      : await tx.db.clientReports.update(reportId, { issueId });
    // A reporter who wrote while the report was new is still waiting.
    if (report?.clientWaiting === true) {
      await refreshIssueWaiting(tx, issueId);
    }
  }
}

// Every report follows its linked issues (A23, A24; all in the report's
// project, so their writes are serialised by the project's lock: two of them
// settling at once never both see the other open): when all of them are done,
// cancelled or deleted, the report is closed (the settling date starts the 90
// days of the retention); when one of them is moved back to live work, it is
// accepted again, unless their personal data is already erased. Runs inside
// the issue's transaction (registered in module.ts). On creation it also sets
// the report's `issueId`.
export async function followIssue(
  tx: ClosingMongo,
  change: IssueChange,
): Promise<undefined> {
  if (change.verb === "created") {
    await linkCreated(tx, change);
    return;
  }
  const deleted = change.verb === "deleted";
  const reports = await reportsOfIssue(tx, change.issue._id);
  // A deleted issue takes its links with it; a request keeps the earliest
  // link left as its first one.
  if (deleted) {
    await tx.db.clientReportLinks.hardDeleteMany({ issueId: change.issue._id });
  }
  if (reports.length === 0) return;
  // The issue is gone, and so are the files on a request that has no other
  // issue: their records carry a removal date, and the files retention job
  // removes them with their objects.
  const closing: ClientReportDocument[] = [];
  for (const report of reports) {
    const ids = (await linkedIssueIds(tx, [report])).get(report.id) ?? [];
    const rest = deleted
      ? ids.filter((id) => !id.equals(change.issue._id))
      : ids;
    if (deleted && report.issueId?.equals(change.issue._id) && rest[0]) {
      await tx.db.clientReports.update(report._id, { issueId: rest[0] });
    }
    if (deleted && rest.length === 0) closing.push(report);
    await settleReport(tx, report, rest, change);
  }
  if (closing.length > 0) {
    await tx.db.clientReportFiles.updateMany(
      {
        reportId: { $in: closing.map((report) => report._id) },
        state: { $in: ["released", "quarantined"] },
      },
      { expiresAt: new Date() },
    );
  }
}

// Closes an accepted request whose links are all settled, and accepts a closed
// one again when a link is live (unless its data is erased). `change` is the
// issue change in flight, if any: that issue is taken as it left it.
export async function settleReport(
  tx: ClosingMongo,
  report: ClientReportDocument,
  issueIds: readonly ObjectId[],
  change?: IssueChange,
): Promise<void> {
  if (report.state === "new" || report.state === "declined") return;
  const settled = await allSettled(tx, change, issueIds);
  if (settled && report.state === "accepted") {
    await tx.db.clientReports.update(report._id, {
      state: "closed",
      closedAt: new Date(),
    });
  } else if (!settled && report.state === "closed" && !report.erasedAt) {
    await tx.db.clientReports.update(report._id, {
      state: "accepted",
      closedAt: null,
    });
  }
}

// Whether every issue a request is linked to is done or cancelled (the
// changed one as the change left it); a request with no issue left is.
async function allSettled(
  tx: ClosingMongo,
  change: IssueChange | undefined,
  issueIds: readonly ObjectId[],
): Promise<boolean> {
  for (const id of issueIds) {
    const issue =
      change && id.equals(change.issue._id)
        ? change.issue
        : await tx.db.issues.findById(id);
    if (issue && !(await isSettled(tx, issue))) return false;
  }
  return true;
}

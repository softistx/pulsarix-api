import type { ModuleMongo } from "../../config/db";
import type { IssueChange } from "../issues/public";
import { refreshIssueWaiting } from "./intake.waiting";

type ClosingMongo = ModuleMongo<"intake"> & ModuleMongo<"issues">;

// Whether an issue stands in a done or cancelled status.
export async function isSettled(
  mongo: ModuleMongo<"issues">,
  issue: IssueChange["issue"],
): Promise<boolean> {
  const status = await mongo.db.statuses.findById(issue.statusId);
  return status?.category === "done" || status?.category === "cancelled";
}

// Every report follows its issue, the ones linked to it as duplicates (A15)
// as well as the one it was made from: when the issue is done, cancelled or
// deleted, the reports are closed (the settling date starts the 90 days of
// the retention); when the issue is moved back to live work, they are
// accepted again, unless their personal data is already erased. Runs inside
// the issue's transaction (registered in module.ts). On creation it also sets
// the report's `issueId`.
export async function followIssue(
  tx: ClosingMongo,
  change: IssueChange,
): Promise<undefined> {
  // The issue and the report's pointer to it are written together: a created
  // issue always has its report's `issueId` set (accepting a report, intake.reports.ts).
  if (change.verb === "created") {
    const reportId = change.issue.clientReportId;
    if (reportId) {
      const report = await tx.db.clientReports.update(reportId, {
        issueId: change.issue._id,
      });
      // A reporter who wrote while the report was new is still waiting.
      if (report.clientWaiting === true) {
        await refreshIssueWaiting(tx, change.issue._id);
      }
    }
    return;
  }
  const reports = await tx.db.clientReports.findMany({
    filter: { issueId: change.issue._id },
    limit: 10_000,
  });
  if (reports.length === 0) return;
  const deleted = change.verb === "deleted";
  // The issue is gone, and so are the files on it: their records carry a
  // removal date, and the files retention job removes them with their objects.
  if (deleted) {
    await tx.db.clientReportFiles.updateMany(
      {
        reportId: { $in: reports.map((report) => report._id) },
        state: { $in: ["released", "quarantined"] },
      },
      { expiresAt: new Date() },
    );
  }
  const settled = deleted || (await isSettled(tx, change.issue));
  for (const report of reports) {
    if (report.state === "new" || report.state === "declined") continue;
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
}

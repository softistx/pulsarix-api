import type { ModuleMongo } from "../../config/db";
import type { IssueChange } from "../issues/public";

type ClosingMongo = ModuleMongo<"intake"> & ModuleMongo<"issues">;

// A report follows its issue: when the issue is done, cancelled or deleted, the
// report is closed (its settling date starts the 90 days of the retention);
// when the issue is moved back to live work, the report is accepted again,
// unless its personal data is already erased. Runs inside the issue's
// transaction (registered in module.ts). On creation it also sets the report's
// `issueId`.
export async function followIssue(
  mongo: ModuleMongo<"issues">,
  change: IssueChange,
): Promise<undefined> {
  const reportId = change.issue.clientReportId;
  if (!reportId) return;
  const tx = mongo as unknown as ClosingMongo;
  // The issue and the report's pointer to it are written together: a created
  // issue always has its report's `issueId` set (accepting a report, intake.reports.ts).
  if (change.verb === "created") {
    await tx.db.clientReports.update(reportId, { issueId: change.issue._id });
    return;
  }
  const report = await tx.db.clientReports.findById(reportId);
  if (!report || report.state === "new" || report.state === "declined") return;
  let settled = change.verb === "deleted";
  // The issue is gone, and so are the files on it: their records carry a
  // removal date, and the files retention job removes them with their objects.
  if (settled) {
    await tx.db.clientReportFiles.updateMany(
      { reportId, state: { $in: ["released", "quarantined"] } },
      { expiresAt: new Date() },
    );
  }
  if (!settled) {
    const status = await tx.db.statuses.findById(change.issue.statusId);
    settled = status?.category === "done" || status?.category === "cancelled";
  }
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

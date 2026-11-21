import type { AppTenancy, ModuleMongo } from "../../../config/db";
import { SYSTEM_ACTOR } from "../../../core/shared/actors";
import { markIssue } from "./markers.service";
import { refreshIssueWaiting } from "./waiting.service";
import type { ClientReportDocument } from "../models";

// How long a settled report keeps its personal data (plan Q15).
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

type RetentionMongo = ModuleMongo<"intake">;

// The one eraser of a report's personal data (plan §19), shared by the
// retention job below, the widget's "Delete my data" and the tracking page's:
// e-mail, reporter name and key, user agent, page, metadata, tracking token,
// the thread's messages and every file of the report (released ones too: they
// get a removal date, and the files retention job removes them with their
// objects). `erasedAt` is stamped and the issue is marked "client deleted";
// the report's title and description stay, the team's record of what was asked.
// Safe to repeat.
export async function eraseReport(
  mongo: RetentionMongo,
  report: ClientReportDocument,
  now = new Date(),
  // The retention job keeps the files and the issue as they are; the
  // reporter's own request ("Delete my data") also removes the files and marks
  // the issue.
  options: { files?: boolean; mark?: boolean } = {},
): Promise<void> {
  const { files = true, mark = true } = options;
  const as = mongo.as(SYSTEM_ACTOR);
  // What the reporter wrote in the thread is personal data too: the messages
  // leave both threads (A16).
  await as.db.clientReportMessages.updateMany(
    { reportId: report._id, erasedAt: null },
    { body: "", erasedAt: now },
  );
  if (files) {
    await as.db.clientReportFiles.updateMany(
      {
        reportId: report._id,
        $or: [
          { state: { $in: ["released", "quarantined"] }, expiresAt: null },
          { state: "pending" },
        ],
      },
      { expiresAt: now },
    );
  }
  // The report itself goes last: its `reporterKey` is the reporter's handle, so
  // a step that failed above leaves the report reachable and the erase can be
  // asked again.
  await as.db.clientReports.update(report._id, {
    email: null,
    reporterKey: null,
    reporterName: null,
    userAgent: null,
    pageUrl: null,
    metadata: [],
    trackingTokenHash: null,
    trackingTokenSealed: null,
    erasedAt: now,
    clientWaiting: false,
  });
  if (report.issueId) {
    // An erased report no longer makes its issue wait.
    await refreshIssueWaiting(as, report.issueId);
    if (mark) await markIssue(as, report.issueId, "deleted");
  }
}

// Erases, in one organisation, every report settled `RETENTION_DAYS` ago
// (declined: from its decision; closed: from its closing) with `eraseReport`.
// Safe to repeat. Answers how many reports it erased.
export async function eraseSettled(
  mongo: RetentionMongo,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const due = await mongo.db.clientReports.findMany({
    filter: {
      erasedAt: null,
      $or: [
        { state: "declined", decidedAt: { $lte: cutoff } },
        { state: "closed", closedAt: { $lte: cutoff } },
      ],
    },
    limit: 1_000,
  });
  for (const report of due)
    await eraseReport(mongo, report, now, { files: false, mark: false });
  return due.length;
}

// The retention job over every active organisation. One organisation failing
// does not stop the others; the job fails afterwards, so the queue retries it.
export async function eraseAll(
  tenancy: Pick<AppTenancy, "eachTenant">,
  now = new Date(),
  log: (message: string, error?: unknown) => void = console.warn,
): Promise<number> {
  const results = await tenancy.eachTenant(
    async (_tenant, mongo) => eraseSettled(mongo, now),
    { onError: "collect" },
  );
  let erased = 0;
  let failed = 0;
  for (const result of results) {
    if (result.ok) erased += result.value;
    else {
      failed += 1;
      log("intake retention failed for an organisation", result.error);
    }
  }
  if (failed > 0) {
    throw new Error(`intake retention failed for ${failed} organisation(s)`);
  }
  return erased;
}

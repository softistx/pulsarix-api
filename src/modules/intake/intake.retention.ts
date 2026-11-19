import type { AppTenancy, ModuleMongo } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { refreshIssueWaiting } from "./intake.waiting";

// How long a settled report keeps its personal data (plan Q15).
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

type RetentionMongo = ModuleMongo<"intake">;

// Erases, in one organisation, the e-mail, the user agent and the tracking
// token of every report settled `RETENTION_DAYS` ago (declined: from its
// decision; closed: from its closing), and stamps `erasedAt`. The report's text
// stays: the team's record of what was asked. Safe to repeat. Answers how many
// reports it erased.
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
  const as = mongo.as(SYSTEM_ACTOR) as unknown as RetentionMongo;
  for (const report of due) {
    await as.db.clientReports.update(report._id, {
      email: null,
      userAgent: null,
      pageUrl: null,
      metadata: [],
      trackingTokenHash: null,
      erasedAt: now,
      clientWaiting: false,
    });
    // An erased report no longer makes its issue wait.
    if (report.issueId) {
      await refreshIssueWaiting(
        as as unknown as Parameters<typeof refreshIssueWaiting>[0],
        report.issueId,
      );
    }
    // What the reporter wrote in the thread is personal data too: the messages
    // leave both threads (A16).
    await as.db.clientReportMessages.updateMany(
      { reportId: report._id, erasedAt: null },
      { body: "", erasedAt: now },
    );
  }
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
    async (_tenant, mongo) =>
      eraseSettled(mongo as unknown as RetentionMongo, now),
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

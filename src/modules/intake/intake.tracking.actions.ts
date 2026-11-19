import { exhausted } from "../../core/shared/errors";
import { retryWriteConflicts } from "../../core/shared/locked";
import { keyDisabled } from "./intake.errors";
import type { DeclaredFile } from "./intake.files.input";
import {
  type Reply,
  type RequestSummary,
  reopenReport,
  replyToReport,
  resolveReport,
} from "./intake.requests";
import { eraseReport } from "./intake.retention";
import type { PublicIntake } from "./intake.submit";
import { scopeOf } from "./intake.tracking";

// What the tracking page does with its report (plan §19, A18): the actions of
// the widget's "My requests" (A17), by tracking token instead of identity, and
// through the same services, so the rules are the same (the 30 days of
// "Reopen", a declined request read-only, the limits, the shared eraser). For
// the UI server only (intake.routes.ts refuses an `Origin` and a missing client
// header). Every call is over the address's tracking limit first, and a token
// that is malformed, unknown or erased gets the one 404 of a missing report.

async function open(intake: PublicIntake, token: string | null, ip: string) {
  await intake.limit((l) => l.intakeTrackingIp, { ip });
  return scopeOf(intake, token ?? "");
}

// The reporter answers in their thread. The files' tickets are the tracking
// page's: the UI server PUTs them (no `Origin`, the client header).
export async function trackingReply(
  intake: PublicIntake,
  token: string | null,
  ip: string,
  given: { body: string; files?: readonly DeclaredFile[] | null },
): Promise<Reply> {
  const { scope, report } = await open(intake, token, ip);
  if (!scope.key.active) throw keyDisabled();
  return replyToReport(intake, scope, report, given, { tracking: true });
}

export async function trackingResolve(
  intake: PublicIntake,
  token: string | null,
  ip: string,
): Promise<RequestSummary> {
  const { scope, report } = await open(intake, token, ip);
  return resolveReport(intake, scope, report);
}

export async function trackingReopen(
  intake: PublicIntake,
  token: string | null,
  ip: string,
): Promise<RequestSummary> {
  const { scope, report } = await open(intake, token, ip);
  return reopenReport(intake, scope, report);
}

// The e-mail switch of this one request.
export async function trackingEmails(
  intake: PublicIntake,
  token: string | null,
  ip: string,
  on: boolean,
): Promise<boolean> {
  const { scope, report } = await open(intake, token, ip);
  await scope.mongo.db.clientReports.update(report._id, { emailsOff: !on });
  return on;
}

// "Delete my data" for this request, through the shared eraser; the token is
// unknown afterwards. Once an hour.
export async function trackingErase(
  intake: PublicIntake,
  token: string | null,
  ip: string,
): Promise<{ requests: number }> {
  const { scope, report } = await open(intake, token, ip);
  await intake.limit((l) => l.intakeReporterErase, {
    keyId: scope.key.id,
    reporterKey: scope.reporter.reporterKey,
  });
  const now = intake.now();
  await retryWriteConflicts(
    () => eraseReport(scope.mongo, report, now),
    exhausted,
  );
  return { requests: 1 };
}

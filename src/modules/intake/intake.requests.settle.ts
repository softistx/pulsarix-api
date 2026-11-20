import { SYSTEM_ACTOR } from "../../core/shared/actors";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import { exhausted } from "../../core/shared/errors";
import { retryWriteConflicts } from "../../core/shared/locked";
import { type ActivityMongo, journalOnIssue } from "../activity/public";
import { reopenExpired, requestDeclined } from "./intake.errors";
import { announceChanged } from "./intake.live";
import { markIssue } from "./intake.markers";
import type { ClientReportDocument } from "./intake.model";
import { derivePublicState, mappedStateOf } from "./intake.publicstate";
import {
  canReopenAt,
  type RequestSummary,
  settledAt,
  summaryOfOwned,
} from "./intake.requests.read";
import type { Scope } from "./intake.requests.session";
import type { IntakeMongo, PublicIntake } from "./intake.submit";
import { ownedReport } from "./intake.thread";
import { refreshIssueWaiting } from "./intake.waiting";

// "Mark as resolved" and "Reopen": the reporter settles their request.

type ReportPatch = Parameters<IntakeMongo["db"]["clientReports"]["update"]>[1];

type SettleMongo = IntakeMongo &
  Parameters<typeof refreshIssueWaiting>[0] &
  Parameters<typeof markIssue>[0];

// Resolve or reopen, in one transaction: the report's marks, the issue's
// marker, and the journal entry that tells its watchers and assignee. The
// issue's status never moves.
async function settle(
  intake: PublicIntake,
  session: Scope,
  report: ClientReportDocument,
  verb: "clientResolved" | "clientReopened",
  patch: ReportPatch,
): Promise<void> {
  let later: AfterCommit[] = [];
  await retryWriteConflicts(
    () =>
      session.mongo.transaction(async (raw) => {
        later = [];
        const tx = raw as unknown as SettleMongo;
        await tx.db.clientReports.update(report._id, patch);
        if (report.issueId) {
          const issue = await tx.db.issues.findById(report.issueId);
          if (issue) {
            await markIssue(
              tx,
              issue._id,
              verb === "clientResolved" ? "resolved" : "reopened",
            );
            await refreshIssueWaiting(tx, issue._id);
            later.push(
              await journalOnIssue(tx as unknown as ActivityMongo, {
                issue,
                organisationId: session.organisationId,
                actorId: SYSTEM_ACTOR,
                verb,
                comment: null,
              }),
            );
          }
        }
        return undefined;
      }),
    exhausted,
  );
  later.push(
    announceChanged(session.organisationId, [report], () => intake.now()),
  );
  await runAfterCommit(later);
}

async function settleLimit(intake: PublicIntake, session: Scope) {
  await intake.limit((l) => l.intakeReporterSettle, {
    keyId: session.key.id,
    reporterKey: session.reporter.reporterKey,
  });
}

// "Mark as resolved": the request closes for the reporter and the team is told
// (the issue's status does not move). Already resolved: nothing changes.
export async function resolveRequest(
  intake: PublicIntake,
  session: Scope,
  id: string,
): Promise<RequestSummary> {
  const report = await ownedReport(session.mongo, session.reporter, id);
  return resolveReport(intake, session, report);
}

export async function resolveReport(
  intake: PublicIntake,
  session: Scope,
  report: ClientReportDocument,
): Promise<RequestSummary> {
  if (report.state === "declined") throw requestDeclined();
  const mapped = await mappedStateOf(session.mongo, report.issueId);
  if (derivePublicState(report, mapped) !== "resolved") {
    await settleLimit(intake, session);
    await settle(intake, session, report, "clientResolved", {
      resolvedByReporterAt: intake.now(),
      clientWaiting: false,
    });
  }
  return summaryOfOwned(session, report._id);
}

// "Reopen": a resolved request goes back to In progress, within 30 days of its
// settling; the team is told, the issue's status does not move. A request that
// is not resolved stays as it is.
export async function reopenRequest(
  intake: PublicIntake,
  session: Scope,
  id: string,
): Promise<RequestSummary> {
  const report = await ownedReport(session.mongo, session.reporter, id);
  return reopenReport(intake, session, report);
}

export async function reopenReport(
  intake: PublicIntake,
  session: Scope,
  report: ClientReportDocument,
): Promise<RequestSummary> {
  if (report.state === "declined") throw requestDeclined();
  const mapped = await mappedStateOf(session.mongo, report.issueId);
  const state = derivePublicState(report, mapped);
  if (state === "resolved") {
    if (!canReopenAt(settledAt(report, state), intake.now())) {
      throw reopenExpired();
    }
    await settleLimit(intake, session);
    await settle(intake, session, report, "clientReopened", {
      reopenedAt: intake.now(),
      reopenedFrom: mapped,
      // A report the issue closed is live again: its 90 days start over.
      ...(report.state === "closed" && { state: "accepted", closedAt: null }),
    });
  }
  return summaryOfOwned(session, report._id);
}

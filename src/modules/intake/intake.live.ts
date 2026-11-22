import { realtime } from "../../config/redis";
import type { AfterCommit } from "../../core/shared/after-commit";
import type { ClientReportDocument } from "./models";
import type { PublicIntake } from "./services/submit.service";

// Tells the live streams of identified reporters that some of their requests
// changed (plan §19, A17): once a transaction has committed, one event per
// report that has a reporter. The stream (routes/requests.routes.ts) reads what it
// sends from the database, so the event names the report and nothing else.
// A report with no reporter (sent without a token) has no stream to tell.
export function announceChanged(
  organisationId: string,
  reports: readonly Pick<
    ClientReportDocument,
    "id" | "widgetKeyId" | "reporterKey"
  >[],
  now: () => Date = () => new Date(),
): AfterCommit {
  const events = reports.flatMap((report) =>
    report.reporterKey
      ? [
          {
            organisationId,
            keyId: report.widgetKeyId.toHexString(),
            reporterKey: report.reporterKey,
            reportId: report.id,
            at: now().toISOString(),
          },
        ]
      : [],
  );
  return async () => {
    for (const event of events) {
      await realtime.channels.reporterRequestChanged.publish(event);
    }
  };
}

export interface RequestsChange {
  organisationId: string;
  projectId: string;
  reportId: string;
  kind: "new" | "message" | "state";
}

// Tells the organisation's triage stream (`requestsChanged`, A25) that some
// requests changed, once the transaction committed (or at once, for a caller
// outside one). A failed publish never fails the write it follows.
export function announceRequests(
  changes: readonly RequestsChange[],
  now: () => Date = () => new Date(),
): AfterCommit {
  return async () => {
    for (const change of changes) {
      await realtime.channels.requestsChanged
        .publish({ ...change, at: now().toISOString() })
        .catch(() => undefined);
    }
  };
}

// The same events for reports already read.
export const requestsOf = (
  organisationId: string,
  reports: readonly Pick<ClientReportDocument, "id" | "projectId">[],
  kind: RequestsChange["kind"],
): RequestsChange[] =>
  reports.map((report) => ({
    organisationId,
    projectId: report.projectId.toHexString(),
    reportId: report.id,
    kind,
  }));

// After the commit: the organisation's triage stream and the message's
// subscribers are told, in the background (a failure never fails the post).
export function announcePosted(
  intake: PublicIntake,
  organisationId: string,
  report: ClientReportDocument,
  messageId: string,
): void {
  intake.background(
    announceRequests(requestsOf(organisationId, [report], "message"), () =>
      intake.now(),
    ),
  );
  const publish = intake.deps.publishMessage;
  if (!publish) return;
  intake.background(async () => {
    await publish({
      organisationId,
      projectId: report.projectId.toHexString(),
      reportId: report.id,
      messageId,
      at: intake.now().toISOString(),
    });
  });
}

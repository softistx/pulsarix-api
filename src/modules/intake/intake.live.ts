import { realtime } from "../../config/redis";
import type { AfterCommit } from "../../core/shared/after-commit";
import type { ClientReportDocument } from "./intake.model";

// Tells the live streams of identified reporters that some of their requests
// changed (plan §19, A17): once a transaction has committed, one event per
// report that has a reporter. The stream (intake.live.routes.ts) reads what it
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

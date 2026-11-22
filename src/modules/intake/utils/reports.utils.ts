import type { ObjectId } from "mongodb";
import type { Locale } from "../../../i18n/locale";
import { pageUrlOf, type SubmittedReport } from "../rules/submit-input.rules";
import { stripControl } from "./text.utils";

// The decline reason a reporter may read: only a reason the team wrote knowing
// it is shown.
export const declineReasonShown = (report: {
  declineReason: string | null;
  declineReasonPublic?: boolean | undefined;
}) => (report.declineReasonPublic === true ? report.declineReason : null);

type Reporter = {
  reporterKey: string;
  reporterName: string | null;
  email: string | null;
} | null;

// An identified report carries only the e-mail the host vouched for (none when
// its token has no email claim): the form's address is never trusted there, or
// a signed-in user could file with someone else's. An unidentified report uses
// the form's.
export function reporterEmailOf(
  identity: Reporter,
  report: { email?: string | null | undefined },
): string | null {
  if (identity) return identity.email ?? null;
  return report.email ? report.email : null;
}

// The fields of a report as it is stored when a widget files it.
export function newReportFields(input: {
  key: { _id: ObjectId; projectId: ObjectId };
  report: SubmittedReport;
  email: string | null;
  identity: Reporter;
  caller: { userAgent: string | null; language: Locale };
  metadata: { key: string; value: string }[];
  tracking: { hash: string; sealed: string } | null;
}) {
  const { key, report, email, identity, caller, metadata, tracking } = input;
  return {
    projectId: key.projectId,
    widgetKeyId: key._id,
    title: report.title,
    description: report.description,
    email,
    reporterKey: identity?.reporterKey ?? null,
    reporterName: identity?.reporterName ?? null,
    impact: report.impact ?? null,
    type: report.type ?? null,
    trackingTokenHash: tracking?.hash ?? null,
    trackingTokenSealed: tracking?.sealed ?? null,
    state: "new" as const,
    issueId: null,
    declineReason: null,
    declineReasonPublic: false,
    linkedAt: null,
    resolvedByReporterAt: null,
    reopenedAt: null,
    reopenedFrom: null,
    pageUrl: pageUrlOf(report.pageUrl),
    userAgent: stripControl(caller.userAgent ?? "").slice(0, 512) || null,
    locale: report.locale ?? caller.language,
    metadata,
    decidedBy: null,
    decidedAt: null,
    closedAt: null,
    erasedAt: null,
  };
}

import type { ObjectId } from "mongodb";
import type { PublicState } from "../../projects/public";
import { REQUEST_FILES_PATH } from "../intake.http";
import type { Scope } from "./requests-session.service";
import { publicStatesOf, unreadOf } from "./requests-state.service";
import type { PublicIntake } from "./submit.service";
import { ownedReport, readThread } from "./thread.service";
import { type ClientReportDocument, declineReasonShown } from "../models";

// What the reporter reads: one request with its thread (the list of their
// requests is in intake.requests.list.ts).

// Reopening a resolved request is possible for 30 days after it was resolved.
export const REOPEN_DAYS = 30;
const DAY_MS = 86_400_000;
// A reporter's lists hold their 500 newest requests.
const MAX_REQUESTS = 500;

export interface RequestSummary {
  id: string;
  title: string;
  publicState: PublicState;
  impact: ClientReportDocument["impact"];
  type: ClientReportDocument["type"];
  createdAt: string;
  declineReason: string | null;
  unread: number;
}

export const summaryOf = (
  report: ClientReportDocument,
  publicState: PublicState,
  unread: number,
): RequestSummary => ({
  id: report.id,
  title: report.title,
  publicState,
  impact: report.impact ?? null,
  type: report.type ?? null,
  createdAt: report.createdAt.toISOString(),
  declineReason: declineReasonShown(report),
  unread,
});

export const reportsOf = (session: Scope) =>
  session.mongo.db.clientReports.findMany({
    filter: {
      widgetKeyId: session.reporter.keyId,
      reporterKey: session.reporter.reporterKey,
      erasedAt: null,
    },
    sort: { _id: -1 },
    limit: MAX_REQUESTS,
  });

export interface RequestDetail extends RequestSummary {
  description: string;
  thread: {
    id: string;
    from: "reporter" | "team";
    body: string;
    at: string;
    files: { id: string; name: string; thumbnailUrl: string | null }[];
  }[];
  // The files the report was sent with.
  files: { id: string; name: string; thumbnailUrl: string | null }[];
  canReply: boolean;
  canReopen: boolean;
  resolvedAt: string | null;
  emailsOn: boolean;
}

const thumbnailUrl = (
  path: string,
  file: { id: string; thumbnail: boolean },
) => (file.thumbnail ? `${path}/${file.id}` : null);

// When the request settled, for the 30 days of "Reopen": the reporter's own
// resolve when it stands, else the closing of its issue; null when the request
// is not resolved.
export function settledAt(
  report: ClientReportDocument,
  state: PublicState,
): Date | null {
  if (state !== "resolved") return null;
  const resolved = report.resolvedByReporterAt;
  if (resolved && (!report.reopenedAt || report.reopenedAt < resolved)) {
    return resolved;
  }
  return report.closedAt ?? report.updatedAt;
}

export const canReopenAt = (settled: Date | null, now: Date) =>
  settled !== null && now.getTime() - settled.getTime() <= REOPEN_DAYS * DAY_MS;

// One request with its thread (the reporter's messages and files, and the
// team's public replies), never anyone else's.
export async function requestOf(
  intake: PublicIntake,
  session: Scope,
  id: string,
): Promise<RequestDetail> {
  const report = await ownedReport(session.mongo, session.reporter, id);
  return detailOf(intake, session, report, REQUEST_FILES_PATH);
}

// The same for a report already found (the tracking page's), its thumbnails
// under `path`.
export async function detailOf(
  intake: PublicIntake,
  session: Scope,
  report: ClientReportDocument,
  path: string,
): Promise<RequestDetail> {
  const { mongo } = session;
  const [states, unread, thread, files] = await Promise.all([
    publicStatesOf(mongo, [report]),
    unreadOf(mongo, [report]),
    readThread(mongo, report),
    mongo.db.clientReportFiles.findMany({
      filter: {
        reportId: report._id,
        state: { $in: ["quarantined", "released"] },
        role: { $ne: "reply" },
      },
      sort: { _id: 1 },
    }),
  ]);
  const state = states.get(report.id) ?? "received";
  const settled = settledAt(report, state);
  return {
    ...summaryOf(report, state, unread.get(report.id) ?? 0),
    description: report.description,
    thread: thread.map((entry) => ({
      id: entry.id,
      from: entry.from,
      body: entry.body,
      at: entry.at.toISOString(),
      files: entry.files.map((file) => ({
        id: file.id,
        name: file.name,
        thumbnailUrl: thumbnailUrl(path, file),
      })),
    })),
    files: files.map((file) => ({
      id: file.id,
      name: file.fileName,
      thumbnailUrl: thumbnailUrl(path, {
        id: file.id,
        thumbnail: file.previewKey !== null && file.mime !== "application/pdf",
      }),
    })),
    canReply: state !== "declined",
    canReopen: canReopenAt(settled, intake.now()),
    resolvedAt: report.resolvedByReporterAt?.toISOString() ?? null,
    emailsOn: report.emailsOff !== true,
  };
}

// The summary of one request, as the marks answer with.
export async function summaryOfOwned(
  session: Scope,
  id: ObjectId,
): Promise<RequestSummary> {
  const report = await session.mongo.db.clientReports.findById(id);
  if (!report) throw new Error("the request vanished");
  const [states, unread] = await Promise.all([
    publicStatesOf(session.mongo, [report]),
    unreadOf(session.mongo, [report]),
  ]);
  return summaryOf(
    report,
    states.get(report.id) ?? "received",
    unread.get(report.id) ?? 0,
  );
}

import type { ObjectId } from "mongodb";
import { invalid } from "../../core/shared/errors";
import type { PublicState } from "../projects/public";
import { REQUEST_FILES_PATH } from "./intake.http";
import { type ClientReportDocument, declineReasonShown } from "./intake.model";
import type { Scope, Session } from "./intake.requests.session";
import { publicStatesOf, unreadOf } from "./intake.requests.state";
import type { PublicIntake } from "./intake.submit";
import { ownedReport, readThread } from "./intake.thread";

// What the reporter reads: the list of their requests and one request with its
// thread.

// Reopening a resolved request is possible for 30 days after it was resolved.
export const REOPEN_DAYS = 30;
const DAY_MS = 86_400_000;
// A reporter's lists hold their 500 newest requests.
const MAX_REQUESTS = 500;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

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

export type RequestFilter = "OPEN" | "RESOLVED" | "DECLINED" | "ALL";

const matches = (filter: RequestFilter, state: PublicState) =>
  filter === "ALL" ||
  (filter === "OPEN" && (state === "received" || state === "inProgress")) ||
  (filter === "RESOLVED" && state === "resolved") ||
  (filter === "DECLINED" && state === "declined");

export interface MyRequests {
  nodes: RequestSummary[];
  counts: { open: number; resolved: number; declined: number; all: number };
  // The team's public replies the reporter has not read, over every request.
  unread: number;
  emailsOn: boolean;
  endCursor: string | null;
  hasNextPage: boolean;
}

// A page cursor: the group the request was in (u unread, r read) and its id.
// A bare id (an older cursor) is read in the group the request has now.
const cursorOf = (id: string, unread: boolean) => `${unread ? "u" : "r"}:${id}`;

function cursorKey(
  after: string | null | undefined,
  position: ReadonlyMap<string, number>,
  size: number,
  unreadNow: (id: string) => boolean,
): { id: string | null; key: number } {
  if (!after) return { id: null, key: -1 };
  const match = /^([ur]):(.+)$/.exec(after);
  const id = match?.[2] ?? after;
  const index = position.get(id);
  if (index === undefined) {
    throw invalid([{ path: "after", code: "validation.errors.invalid" }]);
  }
  const read = match ? match[1] === "r" : !unreadNow(id);
  return { id, key: (read ? size : 0) + index };
}

// The reporter's requests: unread ones first, then newest first, each page
// starting after the request `after`; the counts are over all of them.
export async function myRequests(
  session: Session,
  args: {
    filter?: RequestFilter | null;
    first?: number | null;
    after?: string | null;
  },
): Promise<MyRequests> {
  const first = args.first ?? DEFAULT_PAGE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE) {
    throw invalid([{ path: "first", code: "validation.errors.out-of-range" }]);
  }
  const reports = await reportsOf(session);
  const [states, unread] = await Promise.all([
    publicStatesOf(session.mongo, reports),
    unreadOf(session.mongo, reports),
  ]);
  const stateOf = (report: ClientReportDocument) =>
    states.get(report.id) ?? "received";
  const counts = { open: 0, resolved: 0, declined: 0, all: reports.length };
  for (const report of reports) {
    const state = stateOf(report);
    if (state === "resolved") counts.resolved += 1;
    else if (state === "declined") counts.declined += 1;
    else counts.open += 1;
  }
  const wanted = reports.filter((report) =>
    matches(args.filter ?? "OPEN", stateOf(report)),
  );
  const isUnread = (report: ClientReportDocument) =>
    (unread.get(report.id) ?? 0) > 0;
  const position = new Map(reports.map((report, index) => [report.id, index]));
  // Unread first, then the list's own order. A page ends at the position its
  // last request had, kept in the cursor with its group: a request that is
  // read (or gets a reply) between two pages moves group, and the cursor
  // still points where it was.
  const keyOf = (report: ClientReportDocument) =>
    (isUnread(report) ? 0 : reports.length) + (position.get(report.id) ?? 0);
  const ordered = wanted.toSorted((a, b) => keyOf(a) - keyOf(b));
  const from = cursorKey(
    args.after,
    position,
    reports.length,
    (id) => (unread.get(id) ?? 0) > 0,
  );
  const rest = ordered.filter(
    (report) => keyOf(report) > from.key && report.id !== from.id,
  );
  const page = rest.slice(0, first);
  const last = page.at(-1);
  const hasNextPage = rest.length > first;
  return {
    nodes: page.map((report) =>
      summaryOf(report, stateOf(report), unread.get(report.id) ?? 0),
    ),
    counts,
    unread: [...unread.values()].reduce((sum, n) => sum + n, 0),
    emailsOn: !reports.some((report) => report.emailsOff === true),
    endCursor: hasNextPage && last ? cursorOf(last.id, isUnread(last)) : null,
    hasNextPage,
  };
}

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

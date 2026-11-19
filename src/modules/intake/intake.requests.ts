import { ObjectId } from "mongodb";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import { exhausted, invalid } from "../../core/shared/errors";
import { retryWriteConflicts } from "../../core/shared/locked";
import { type ActivityMongo, journalOnIssue } from "../activity/public";
import type { PublicState } from "../projects/public";
import {
  fileNotFound,
  identityInvalid,
  keyDisabled,
  originNotAllowed,
  reopenExpired,
  requestDeclined,
} from "./intake.errors";
import type { DeclaredFile } from "./intake.files.input";
import { REQUEST_FILES_PATH } from "./intake.http";
import { type Identity, verifyIdentity } from "./intake.identity";
import { announceChanged } from "./intake.live";
import { markIssue } from "./intake.markers";
import { postMessage } from "./intake.messages";
import {
  type ClientReportDocument,
  declineReasonShown,
  type WidgetKeyDocument,
} from "./intake.model";
import { originAllowed } from "./intake.origins";
import { derivePublicState, mappedStateOf } from "./intake.publicstate";
import { publicStatesOf, unreadOf } from "./intake.requests.state";
import { eraseReport } from "./intake.retention";
import type { FileTicket } from "./intake.slots";
import type { Caller, IntakeMongo, PublicIntake } from "./intake.submit";
import {
  markRead,
  ownedReport,
  type Reporter,
  readThread,
} from "./intake.thread";
import { refreshIssueWaiting } from "./intake.waiting";

// The reporter's side of the public endpoint (plan §19, A17): "My requests",
// one request with its thread, a reply, "resolved", "reopen", the read mark,
// the e-mail switch and "delete my data". Every call starts with `openSession`:
// the key, its origin, the identity token and the reporter's read limit; every
// read after it is filtered by the reporter's key and the report's id, so a
// foreign id answers the same 404 as a missing one.

// Reopening a resolved request is possible for 30 days after it was resolved.
export const REOPEN_DAYS = 30;
const DAY_MS = 86_400_000;
// A reporter's lists hold their 500 newest requests.
const MAX_REQUESTS = 500;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

// What the services below need to know of who asks: the key the report came
// in by, the organisation's database and the reporter's handle (the limits'
// key). The tracking page's is made from its token (intake.tracking.actions.ts).
export interface Scope {
  key: WidgetKeyDocument;
  mongo: IntakeMongo;
  reporter: Reporter;
  organisationId: string;
}

export interface Session extends Scope {
  identity: Identity;
}

// The caller as a reporter: the address is not over its limit, the key is live
// and allows the origin, the identity token is good (401 when there is none or
// it is not), and the reporter is not over its read limit. A stream open counts
// as a read.
export async function openSession(
  intake: PublicIntake,
  publicKey: string,
  caller: Caller,
): Promise<Session> {
  await intake.guardAddress(caller.ip);
  const key = await intake.keyOf(publicKey);
  if (!originAllowed(caller.origin, key.allowedOrigins)) {
    throw originNotAllowed();
  }
  caller.originGranted = true;
  if (!key.active) throw keyDisabled();
  if (caller.identity == null) throw identityInvalid();
  const identity = verifyIdentity(caller.identity, key, intake.now());
  const reporter: Reporter = {
    keyId: key._id,
    reporterKey: identity.reporterKey,
  };
  await intake.limit((l) => l.intakeReporterRead, {
    keyId: key.id,
    reporterKey: identity.reporterKey,
  });
  intake.touch(key);
  return {
    key,
    mongo: await intake.databaseOf(key),
    reporter,
    identity,
    organisationId: key.organisationId.toHexString(),
  };
}

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

const summaryOf = (
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

const reportsOf = (session: Scope) =>
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
  const unreadFirst = [
    ...wanted.filter((report) => (unread.get(report.id) ?? 0) > 0),
    ...wanted.filter((report) => (unread.get(report.id) ?? 0) === 0),
  ];
  const after = args.after
    ? unreadFirst.findIndex((report) => report.id === args.after)
    : -1;
  if (args.after && after < 0) {
    throw invalid([{ path: "after", code: "validation.errors.invalid" }]);
  }
  const page = unreadFirst.slice(after + 1, after + 1 + first);
  const last = page.at(-1);
  const hasNextPage = after + 1 + first < unreadFirst.length;
  return {
    nodes: page.map((report) =>
      summaryOf(report, stateOf(report), unread.get(report.id) ?? 0),
    ),
    counts,
    unread: [...unread.values()].reduce((sum, n) => sum + n, 0),
    emailsOn: !reports.some((report) => report.emailsOff === true),
    endCursor: hasNextPage && last ? last.id : null,
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
function settledAt(
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

const canReopenAt = (settled: Date | null, now: Date) =>
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
async function summaryOfOwned(
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

export interface Reply {
  messageId: string;
  files: FileTicket[];
}

// The reporter answers in the thread of their request: text and files (the
// report's file rules; the tickets are for `PUT /public/media/report-files`).
export async function replyToRequest(
  intake: PublicIntake,
  session: Scope,
  id: string,
  given: { body: string; files?: readonly DeclaredFile[] | null },
): Promise<Reply> {
  const report = await ownedReport(session.mongo, session.reporter, id);
  return replyToReport(intake, session, report, given);
}

// The reply to a report already found. `tracking` marks the tickets of the
// tracking page's files: the UI server PUTs them, with no `Origin`.
export async function replyToReport(
  intake: PublicIntake,
  session: Scope,
  report: ClientReportDocument,
  given: { body: string; files?: readonly DeclaredFile[] | null },
  options: { tracking?: boolean } = {},
): Promise<Reply> {
  const params = {
    keyId: session.key.id,
    reporterKey: session.reporter.reporterKey,
  };
  await intake.limit((l) => l.intakeReporterReply, params);
  await intake.limit((l) => l.intakeKeyReply, { keyId: session.key.id });
  const posted = await postMessage(
    intake,
    session.mongo,
    session.key,
    report,
    given,
    options,
  );
  // The reporter's other tabs follow.
  await runAfterCommit([
    announceChanged(session.organisationId, [report], () => intake.now()),
  ]);
  return posted;
}

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

// The reporter read the request's thread up to now. Answers their total unread
// count (the launcher's badge).
export async function markRequestRead(
  intake: PublicIntake,
  session: Session,
  id: string,
): Promise<{ count: number }> {
  const report = await ownedReport(session.mongo, session.reporter, id);
  await markRead(session.mongo, report, intake.now());
  await runAfterCommit([
    announceChanged(session.organisationId, [report], () => intake.now()),
  ]);
  const unread = await unreadOf(session.mongo, await reportsOf(session));
  return { count: [...unread.values()].reduce((sum, n) => sum + n, 0) };
}

// The e-mail switch of the reporter's requests (A19 sends them): on or off for
// every request of the reporter under this key.
export async function setRequestEmails(
  session: Session,
  on: boolean,
): Promise<boolean> {
  await session.mongo.db.clientReports.updateMany(
    {
      widgetKeyId: session.reporter.keyId,
      reporterKey: session.reporter.reporterKey,
      erasedAt: null,
    },
    { emailsOff: !on },
  );
  return on;
}

// "Delete my data": every request of the reporter under this key goes through
// the shared eraser (intake.retention.ts). Once an hour: the hour is spent
// after the erasure succeeded, so a failed one (a 5xx) can be retried at once.
export async function eraseMyData(
  intake: PublicIntake,
  session: Session,
): Promise<{ requests: number }> {
  const now = intake.now();
  let requests = 0;
  // Every request of the reporter, not only the newest 500: an erased report
  // leaves the filter, so each page is the next one.
  for (;;) {
    const page = await session.mongo.db.clientReports.findMany({
      filter: {
        widgetKeyId: session.reporter.keyId,
        reporterKey: session.reporter.reporterKey,
        erasedAt: null,
      },
      sort: { _id: -1 },
      limit: 100,
    });
    if (page.length === 0) break;
    for (const report of page) {
      await retryWriteConflicts(
        () => eraseReport(session.mongo, report, now),
        exhausted,
      );
      requests += 1;
    }
  }
  await intake.limit((l) => l.intakeReporterErase, {
    keyId: session.key.id,
    reporterKey: session.reporter.reporterKey,
  });
  return { requests };
}

// Where the 256 px thumbnail of one of the reporter's pictures sits: a file of
// one of their own requests (a foreign or missing id answers the same 404),
// never an original, never a PDF.
export async function thumbnailOf(
  session: Session,
  fileId: string,
): Promise<{ organisationId: string; storageKey: string }> {
  if (!/^[0-9a-f]{24}$/.test(fileId)) throw fileNotFound();
  const file = await session.mongo.db.clientReportFiles.findFirst({
    _id: new ObjectId(fileId),
    state: { $in: ["quarantined", "released"] },
  });
  if (!file?.storageKey || file.previewKey === null) throw fileNotFound();
  if (file.mime === "application/pdf") throw fileNotFound();
  await ownedReport(
    session.mongo,
    session.reporter,
    file.reportId.toHexString(),
  );
  return {
    organisationId: session.organisationId,
    storageKey: file.storageKey,
  };
}

export interface RequestUpdate {
  id: string;
  publicState: PublicState;
  unread: number;
}

// What the live stream tells about one changed request, read from the
// database; null when it is gone, erased or not the reporter's.
export async function updateOf(
  session: Session,
  id: string,
): Promise<{ update: RequestUpdate; total: number } | null> {
  const reports = await reportsOf(session);
  const report = reports.find((candidate) => candidate.id === id);
  if (!report) return null;
  const [states, unread] = await Promise.all([
    publicStatesOf(session.mongo, [report]),
    unreadOf(session.mongo, reports),
  ]);
  return {
    update: {
      id,
      publicState: states.get(id) ?? "received",
      unread: unread.get(id) ?? 0,
    },
    total: [...unread.values()].reduce((sum, n) => sum + n, 0),
  };
}

export async function unreadTotal(session: Session): Promise<number> {
  const unread = await unreadOf(session.mongo, await reportsOf(session));
  return [...unread.values()].reduce((sum, n) => sum + n, 0);
}

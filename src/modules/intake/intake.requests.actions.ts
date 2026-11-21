import { ObjectId } from "mongodb";
import { runAfterCommit } from "../../core/shared/after-commit";
import { exhausted } from "../../core/shared/errors";
import { retryWriteConflicts } from "../../core/shared/locked";
import { fileNotFound } from "./intake.errors";
import type { DeclaredFile } from "./intake.files.input";
import { announceChanged } from "./intake.live";
import { postMessage } from "./intake.messages";
import { reportsOf } from "./intake.requests.read";
import type { Scope, Session } from "./intake.requests.session";
import { unreadOf } from "./intake.requests.state";
import { eraseReport } from "./intake.retention";
import type { FileTicket } from "./intake.slots";
import type { PublicIntake } from "./intake.submit";
import { markRead, ownedReport } from "./intake.thread";
import type { ClientReportDocument } from "./models";

// What the reporter does besides settling: reply, the read mark, the e-mail
// switch, "delete my data" and the thumbnail read.

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

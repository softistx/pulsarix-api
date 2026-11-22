import { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import { SYSTEM_ACTOR } from "../../../core/shared/actors";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../../core/shared/after-commit";
import { exhausted, invalid } from "../../../core/shared/errors";
import { retryWriteConflicts } from "../../../core/shared/locked";
import { journalOnIssue } from "../../activity/public";
import {
  attachmentsDisabled,
  reportNotFound,
  requestDeclined,
} from "../intake.errors";
import { announcePosted } from "../intake.live";
import {
  type ClientReportDocument,
  MAX_MESSAGE,
  type WidgetKeyDocument,
} from "../models";
import { checkFiles, type DeclaredFile } from "../rules/files-input.rules";
import { attachmentsOn } from "../utils/attachments.utils";
import { stripControl } from "../utils/text.utils";
import { eachLinkedIssue } from "./linked-reports.service";
import { type FileTicket, reserveSlots, ticketExpiry } from "./slots.service";
import type { IntakeMongo, PublicIntake } from "./submit.service";
import { refreshLinkedIssuesWaiting } from "./waiting.service";

type MessageMongo = IntakeMongo & ModuleMongo<"issues">;

export interface Posted {
  messageId: string;
  // One ticket per declared file, to PUT to `/public/media/report-files/<slot>`.
  files: FileTicket[];
}

// What a reporter writes in a message: plain text, control characters out.
export function messageBody(given: string): string {
  const body = stripControl(given).trim();
  if (body.length === 0) {
    throw invalid([{ path: "body", code: "validation.errors.required" }]);
  }
  if (body.length > MAX_MESSAGE) {
    throw invalid([
      {
        path: "body",
        code: "validation.errors.too-long",
        params: { max: MAX_MESSAGE },
      },
    ]);
  }
  return body;
}

// The reporter writes in the thread of their request (plan §19, A16). One
// transaction makes the message, the slots of its files (role `reply`, the
// tickets of a report's files: same types, counts and sizes, same quarantine),
// the "client is waiting" flag on the report and its issue, and, when the
// report has an issue, the `clientReplied` entry of its journal that tells the
// watchers and the assignee. The caller is the public endpoint (A17), which has
// checked the key, the reporter and the rate limits; `report` is the
// reporter's own (`ownedReport`).
export async function postMessage(
  intake: PublicIntake,
  mongo: IntakeMongo,
  key: WidgetKeyDocument,
  report: ClientReportDocument,
  given: { body: string; files?: readonly DeclaredFile[] | null },
  options: { tracking?: boolean } = {},
): Promise<Posted> {
  if (report.state === "declined") throw requestDeclined();
  const body = messageBody(given.body);
  const declared = given.files ?? [];
  if (declared.length > 0 && !attachmentsOn(key)) throw attachmentsDisabled();
  let files: ReturnType<typeof checkFiles>;
  try {
    files = checkFiles(declared);
  } catch (error) {
    intake.countRefusal(key._id, error);
    throw error;
  }
  const expiresAt = ticketExpiry(intake.now());
  const organisationId = key.organisationId.toHexString();
  let later: AfterCommit[] = [];
  let posted: Posted | undefined;
  await retryWriteConflicts(
    () =>
      mongo.transaction(async (raw) => {
        const written = await writeMessage(raw, {
          intake,
          key,
          report,
          body,
          files,
          expiresAt,
          tracking: options.tracking === true,
        });
        later = written.later;
        posted = written.posted;
        return undefined;
      }),
    exhausted,
  );
  await runAfterCommit(later);
  if (!posted) throw new Error("the message was not posted");
  announcePosted(intake, organisationId, report, posted.messageId);
  return posted;
}

// What the transaction writes the message from.
interface MessageWrite {
  intake: PublicIntake;
  key: WidgetKeyDocument;
  report: ClientReportDocument;
  body: string;
  files: ReturnType<typeof checkFiles>;
  expiresAt: Date;
  tracking: boolean;
}

// The transaction's writes: the message, its file slots, the report's flag, the
// issue's flag and the journal entry. `later` is for after the commit.
async function writeMessage(
  tx: MessageMongo,
  w: MessageWrite,
): Promise<{ posted: Posted; later: AfterCommit[] }> {
  const { intake, key, report, body, files, expiresAt, tracking } = w;
  const later: AfterCommit[] = [];
  // The report as it is now: it may have got its issue, or been declined or
  // erased, since the caller read it.
  const current = await tx.db.clientReports.findById(report._id);
  if (!current || current.erasedAt) throw reportNotFound();
  if (current.state === "declined") throw requestDeclined();
  const message = await tx.db.clientReportMessages.create({
    reportId: report._id,
    side: "reporter",
    authorId: null,
    body,
    fileIds: [],
    erasedAt: null,
  });
  const tickets = await reserveSlots(
    intake.deps.ticketSecret,
    tx,
    key,
    report,
    files,
    expiresAt,
    { messageId: message._id, tracking },
  );
  if (tickets.length > 0) {
    await tx.db.clientReportMessages.update(message._id, {
      fileIds: tickets.map((ticket) => new ObjectId(ticket.slot)),
    });
  }
  await tx.db.clientReports.update(report._id, { clientWaiting: true });
  // Every issue the request is linked to waits for the team and journals it.
  await refreshLinkedIssuesWaiting(tx, current);
  await eachLinkedIssue(tx, current, async (issue) => {
    later.push(
      await journalOnIssue(tx, {
        issue,
        organisationId: key.organisationId.toHexString(),
        actorId: SYSTEM_ACTOR,
        verb: "clientReplied",
        comment: null,
      }),
    );
  });
  return { posted: { messageId: message.id, files: tickets }, later };
}

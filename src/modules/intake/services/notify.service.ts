import type { ObjectId } from "mongodb";
import { realtime } from "../../../config/redis";
import type { AfterCommit } from "../../../core/shared/after-commit";
import type { CommentChangeHandler } from "../../comments/public";
import type { IssueChangeHandler } from "../../issues/public";
import type { IntakeMongo, ReporterMailQueue } from "../intake.types";
import { type Mailable, wantsMail } from "../utils/mail.utils";
import { reportsOfIssue } from "./linked-reports.service";

// The reporter's e-mails (plan §19, A19). A public reply of the team, or a
// change of the public state of the request, schedules one job per report
// (`intakeReporterMail`) due 10 minutes later; the replies and changes that
// follow join it, and the job mails all of them in one e-mail. An internal
// comment schedules nothing. A report with no e-mail, whose reporter turned
// the e-mails off (`emailsOff`) or whose data was erased gets none.

export const MAIL_DELAY_MS = 10 * 60_000;

let queue: ReporterMailQueue | undefined = realtime.queues?.intakeReporterMail;

// Swaps the queue the e-mails are scheduled on (a spec's); answers a function
// that puts the previous one back.
export function useReporterMailQueue(
  next: ReporterMailQueue | undefined,
): () => void {
  const previous = queue;
  queue = next;
  return () => {
    queue = previous;
  };
}

// Asks for the report's e-mail in MAIL_DELAY_MS, once the transaction that
// changed it has committed. One job per report and time window: what happens
// in the same window shares it. Without a queue (no Redis, outside
// production) nothing is sent.
export function scheduleReporterMails(
  organisationId: string,
  reports: readonly Mailable[],
  now: () => number = Date.now,
): AfterCommit {
  const due = reports.filter(wantsMail);
  return async () => {
    if (!queue) return;
    const window = Math.floor(now() / MAIL_DELAY_MS);
    for (const report of due) {
      await queue.add(
        { organisationId, reportId: report.id },
        {
          id: `reporter-mail:${organisationId}:${report.id}:${window}`,
          delay: MAIL_DELAY_MS,
        },
      );
    }
  };
}

async function mailable(
  mongo: IntakeMongo,
  issueId: ObjectId,
  organisationId: string,
) {
  const reports = await reportsOfIssue(mongo, issueId, {
    email: { $ne: null },
    erasedAt: null,
  });
  const due = reports.filter(wantsMail);
  return due.length > 0
    ? scheduleReporterMails(organisationId, due)
    : undefined;
}

// A public comment the team wrote. An internal one, an edit and a deletion
// send nothing. Registered in module.ts.
export const mailPublicReply: CommentChangeHandler = async (
  mongo,
  { comment, verb, organisationId },
) => {
  if (!comment.public || verb !== "commented") return undefined;
  return mailable(mongo, comment.issueId, organisationId);
};

// A move of the issue to another status, which may change the request's public
// state; the job decides whether it did. Registered in module.ts.
export const mailStateChange: IssueChangeHandler = async (
  mongo,
  { verb, issue, organisationId, changes },
) => {
  if (verb === "created" || verb === "deleted") return undefined;
  if (!changes.some((change) => change.field === "statusId")) return undefined;
  return mailable(mongo, issue._id, organisationId);
};

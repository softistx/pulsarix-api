import { createHmac } from "node:crypto";
import { type Address, listUnsubscribe, type Mailer } from "@softistx/mail";
import { ObjectId } from "mongodb";
import { realtime } from "../../config/redis";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import type { AfterCommit } from "../../core/shared/after-commit";
import type { CommentChangeHandler } from "../comments/public";
import { withoutMarkers } from "../comments/public";
import type { IssueChangeHandler } from "../issues/public";
import { openTrackingToken } from "./intake.identity";
import { reporterMail } from "./intake.mail";
import type { ClientReportDocument } from "./intake.model";
import { publicStateOf } from "./intake.publicstate";
import type { IntakeMongo } from "./intake.submit";
import { publicFilter } from "./intake.thread";
import { UNSUBSCRIBE_PATH, unsubscribeToken } from "./intake.unsubscribe";

// The reporter's e-mails (plan §19, A19). A public reply of the team, or a
// change of the public state of the request, schedules one job per report
// (`intakeReporterMail`) due 10 minutes later; the replies and changes that
// follow join it, and the job mails all of them in one e-mail. An internal
// comment schedules nothing. A report with no e-mail, whose reporter turned
// the e-mails off (`emailsOff`) or whose data was erased gets none.

export const MAIL_DELAY_MS = 10 * 60_000;

// The most replies one e-mail reads out; the rest are counted.
export const MAIL_LISTED = 5;
const MAIL_FETCH = 200;
const REPLY_CLIP = 1_000;

export interface ReporterMailJob {
  organisationId: string;
  reportId: string;
}

// What the scheduling needs of a queue: the bound queue of @softistx/redis has it.
export interface ReporterMailQueue {
  add(
    data: ReporterMailJob,
    options: { id: string; delay: number },
  ): Promise<{ deduplicated: boolean }>;
}

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

type Mailable = Pick<
  ClientReportDocument,
  "id" | "email" | "emailsOff" | "erasedAt"
>;

const wantsMail = (report: Mailable) =>
  !!report.email && report.emailsOff !== true && !report.erasedAt;

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
  const reports = await mongo.db.clientReports.findMany({
    filter: { issueId, email: { $ne: null }, erasedAt: null },
    limit: 100,
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

// The secret the unsubscribe links are signed with, derived from the upload
// tickets' key so that no new setting is needed.
export const unsubscribeSecret = (ticketSecret: string) =>
  createHmac("sha256", ticketSecret)
    .update("pulsarix reporter mail unsubscribe")
    .digest("hex");

// What a job reaches outside the organisation's database.
export interface ReporterMailDeps {
  mongo(organisationId: string): Promise<IntakeMongo>;
  mailer: Mailer;
  from: Address;
  uiOrigin: string;
  // The allow-list of the widget key a report came in through.
  allowedOrigins(widgetKeyId: ObjectId): Promise<readonly string[]>;
  // The key unsubscribe links are signed with (`unsubscribeSecret`).
  secret: string;
}

// The page the reporter filed from, as a link in the e-mail: only when its
// origin is one of the key's allowed origins. The page URL is client-supplied,
// so any other would let a reporter put their own link in a branded mail.
async function hostPageLink(
  deps: ReporterMailDeps,
  report: ClientReportDocument,
): Promise<string | null> {
  if (!report.pageUrl) return null;
  let origin: string;
  try {
    origin = new URL(report.pageUrl).origin;
  } catch {
    return null;
  }
  const allowed = await deps.allowedOrigins(report.widgetKeyId);
  return allowed.includes(origin) ? report.pageUrl : null;
}

export type ReporterMailOutcome = "sent" | "nothing" | "skipped";

const clip = (text: string) =>
  text.length > REPLY_CLIP ? `${text.slice(0, REPLY_CLIP)}…` : text;

// Mails the reporter what changed since the last e-mail and marks it mailed.
// "skipped": the report is gone, erased, has no address or turned e-mails off;
// "nothing": no public reply and no state change since the last one. A mail
// that fails throws, and the queue retries the job; a retry after a failure
// between the send and the mark may mail twice (at least once, never lost).
export async function sendReporterMail(
  deps: ReporterMailDeps,
  job: ReporterMailJob,
): Promise<ReporterMailOutcome> {
  if (!/^[0-9a-f]{24}$/.test(job.reportId)) return "skipped";
  const mongo = (await deps.mongo(job.organisationId)).as(SYSTEM_ACTOR);
  const report = await mongo.db.clientReports.findById(
    new ObjectId(job.reportId),
  );
  if (!report?.email || !wantsMail(report)) return "skipped";

  const replies = report.issueId
    ? await mongo.db.comments.findMany({
        filter: publicFilter(report, report.mailedThrough),
        sort: { _id: 1 },
        limit: MAIL_FETCH,
      })
    : [];
  const state = await publicStateOf(mongo, report);
  const changed = state !== (report.mailedState ?? "received");
  if (replies.length === 0 && !changed) return "nothing";

  // The reporter an identity token vouched for reads the replies in the
  // e-mail and lands on the host page; the other one gets the tracking page.
  const identified = report.reporterKey !== null;
  const project = await mongo.db.projects.findById(report.projectId);
  const token =
    !identified && report.trackingTokenSealed
      ? openTrackingToken(
          report.trackingTokenSealed,
          report.widgetKeyId.toHexString(),
        )
      : null;
  const link = identified
    ? await hostPageLink(deps, report)
    : token
      ? `${deps.uiOrigin}/track/${token}`
      : null;
  const unsubscribe = `${deps.uiOrigin}${UNSUBSCRIBE_PATH}/${unsubscribeToken(
    deps.secret,
    job.organisationId,
    report.id,
  )}`;
  const mail = reporterMail({
    locale: report.locale,
    projectName: project?.name ?? "pulsarix",
    replies: identified
      ? replies
          .slice(0, MAIL_LISTED)
          .map((reply) => clip(withoutMarkers(reply.body)))
      : [],
    replyCount: replies.length,
    state: changed ? state : null,
    declineReason:
      changed && state === "declined" && report.declineReasonPublic
        ? report.declineReason
        : null,
    link,
    unsubscribe,
  });
  await deps.mailer.send({
    from: deps.from,
    to: { name: report.email, address: report.email },
    ...mail,
    // RFC 8058 wants an https URL; a development origin over http sends the
    // link in the body only.
    ...(unsubscribe.startsWith("https://") && {
      headers: listUnsubscribe({ url: unsubscribe }),
    }),
  });
  await mongo.db.clientReports.update(report._id, {
    mailedState: state,
    mailedThrough: replies.at(-1)?.createdAt ?? report.mailedThrough,
  });
  return "sent";
}

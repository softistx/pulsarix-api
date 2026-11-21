import { listUnsubscribe } from "@softistx/mail";
import { ObjectId } from "mongodb";
import { SYSTEM_ACTOR } from "../../../core/shared/actors";
import { withoutMarkers } from "../../comments/public";
import { reporterMail } from "../intake.mail";
import type {
  IntakeMongo,
  ReporterMailDeps,
  ReporterMailJob,
  ReporterMailOutcome,
} from "../intake.types";
import { UNSUBSCRIBE_PATH, unsubscribeToken } from "../intake.unsubscribe";
import type { ClientReportDocument } from "../models";
import { clip, hostPageLink, wantsMail } from "../utils/mail.utils";
import { openTrackingToken } from "./identity.service";
import { publicStateOf } from "./public-state.service";
import { publicFilter } from "./thread.service";

// The most replies one e-mail reads out; the rest are counted.
export const MAIL_LISTED = 5;
const MAIL_FETCH = 200;

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
  const email = report.email;

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

  const unsubscribe = `${deps.uiOrigin}${UNSUBSCRIBE_PATH}/${unsubscribeToken(
    deps.secret,
    job.organisationId,
    report.id,
  )}`;
  const mail = await mailOf(deps, mongo, report, {
    replies,
    state,
    changed,
    unsubscribe,
  });
  await deps.mailer.send({
    from: deps.from,
    to: { name: email, address: email },
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

// The reporter an identity token vouched for reads the replies in the e-mail
// and lands on the host page; the other one gets the tracking page.
async function mailOf(
  deps: ReporterMailDeps,
  mongo: IntakeMongo,
  report: ClientReportDocument,
  what: {
    replies: Array<{ body: string }>;
    state: Awaited<ReturnType<typeof publicStateOf>>;
    changed: boolean;
    unsubscribe: string;
  },
) {
  const { replies, state, changed, unsubscribe } = what;
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
    ? await hostPageLink(report, deps.allowedOrigins)
    : token
      ? `${deps.uiOrigin}/track/${token}`
      : null;
  return reporterMail({
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
}

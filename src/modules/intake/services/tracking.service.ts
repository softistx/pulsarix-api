import { ObjectId } from "mongodb";
import { withoutMarkers } from "../../comments/public";
import type { PublicState } from "../../projects/public";
import { fileNotFound, reportNotFound } from "../intake.errors";
import { TRACKING_FILES_PATH } from "../intake.http";
import type {
  ClientReportDocument,
  ReportFileRole,
  ReportState,
} from "../models";
import { declineReasonShown } from "../utils/reports.utils";
import { parseTrackingToken } from "../utils/token.utils";
import { publicStateOf } from "./public-state.service";
import { repliesOf } from "./replies.service";
import { detailOf, type RequestDetail } from "./requests-read.service";
import type { Scope } from "./requests-session.service";
import type { PublicIntake } from "./submit.service";

// The tracking page's reads (the public side of the intake, services/submit.service.ts):
// a report by its token, and the thumbnails of the reporter's own pictures.

// A file the reporter attached, as the tracking page shows it: its name and
// role, and whether a thumbnail can be read (a picture's 256 px rendition;
// never the original, never a PDF).
export interface TrackedFile {
  id: string;
  role: ReportFileRole;
  name: string;
  thumbnail: boolean;
}

export interface Tracked {
  state: ReportState;
  // The four public states (plan §19), derived from the report and the state
  // its issue's status maps to; never the status's name.
  publicState: PublicState;
  // Null unless the team wrote it knowing the reporter reads it.
  declineReason: string | null;
  title: string;
  createdAt: Date;
  replies: { at: Date; body: string }[];
  files: TrackedFile[];
  // The request as the reporter's widget reads it (A17): the thread with the
  // reporter's own messages, impact, type, and what they may still do. Its
  // thumbnails are the tracking page's (`TRACKING_FILES_PATH`).
  request: RequestDetail;
}

const MAX_REPLIES = 50;
// The states in which a report file has its bytes (a pending slot has none).
const STORED = ["quarantined", "released"] as const;
// The reporter gets a thumbnail of a picture only: a PDF's preview is not
// offered back.
const hasThumbnail = (file: { previewKey: string | null; mime: string }) =>
  file.previewKey !== null && file.mime !== "application/pdf";

// The report a tracking token opens, with its organisation's database; 404
// for a token that is malformed, unknown or erased.
export async function reportOf(intake: PublicIntake, token: string) {
  const parsed = parseTrackingToken(token);
  if (!parsed) throw reportNotFound();
  const { tenancy } = intake.deps;
  const tenant = await tenancy.resolve(parsed.organisationId);
  if (!tenant) throw reportNotFound();
  const mongo = await tenancy.databaseOf(tenant.id);
  const report = await mongo.db.clientReports.findFirst({
    trackingTokenHash: parsed.hash,
  });
  if (!report || report.erasedAt) throw reportNotFound();
  return { mongo, report, organisationId: parsed.organisationId };
}

// The report a token opens, as the services of the reporter's side take it
// (services/requests-*.service.ts): the key it came in by and the organisation's database
// as the system. The reporter's handle is the report's own key, or, for a
// report filed without identity, the report itself: it only keys the limits.
// 404 for a token that is malformed, unknown or erased (one answer for all).
export async function scopeOf(
  intake: PublicIntake,
  token: string,
): Promise<{ scope: Scope; report: ClientReportDocument }> {
  const { report, organisationId } = await reportOf(intake, token);
  const key = await intake.deps.core.db.widgetKeys.findFirst({
    _id: report.widgetKeyId,
    organisationId: new ObjectId(organisationId),
  });
  if (!key) throw reportNotFound();
  const mongo = await intake.databaseOf(key);
  return {
    report,
    scope: {
      key,
      mongo,
      organisationId,
      reporter: {
        keyId: key._id,
        reporterKey: report.reporterKey ?? `tracking:${report.id}`,
      },
    },
  };
}

// The tracking page's read: the state, the replies marked public, and the
// reporter's own files (name, role, whether a thumbnail exists), and their
// request (A17: id, description, own thread, impact, type). Nothing of the
// issue leaves (no author, no status name, no private comment).
export async function trackedStatus(
  intake: PublicIntake,
  token: string,
  ip: string,
): Promise<Tracked> {
  await intake.limit((l) => l.intakeTrackingIp, { ip });
  const { scope, report } = await scopeOf(intake, token);
  const { mongo } = scope;
  // Newest MAX_REPLIES, shown oldest first.
  const replies = await repliesOf(mongo, report, {
    newest: true,
    limit: MAX_REPLIES,
  });
  const files = await mongo.db.clientReportFiles.findMany({
    // A reply's files belong to the thread, not to the report's own list.
    filter: {
      reportId: report._id,
      state: { $in: STORED },
      role: { $ne: "reply" },
    },
    sort: { _id: 1 },
  });
  return {
    state: report.state,
    publicState: await publicStateOf(mongo, report),
    declineReason: declineReasonShown(report),
    title: report.title,
    createdAt: report.createdAt,
    replies: replies.map((reply) => ({
      at: reply.createdAt,
      body: withoutMarkers(reply.body),
    })),
    files: files.map((file) => ({
      id: file.id,
      role: file.role,
      name: file.fileName,
      thumbnail: hasThumbnail(file),
    })),
    request: await detailOf(intake, scope, report, TRACKING_FILES_PATH),
  };
}

// The thumbnail of one of the reporter's pictures: where it sits, once the
// token, the file and the picture's kind are checked (the tracking page's
// read limit applies). Never the original, never a PDF.
export async function trackedThumbnail(
  intake: PublicIntake,
  token: string,
  fileId: string,
  ip: string,
): Promise<{ organisationId: string; storageKey: string }> {
  await intake.limit((l) => l.intakeTrackingIp, { ip });
  if (!/^[0-9a-f]{24}$/.test(fileId)) throw fileNotFound();
  const { mongo, report, organisationId } = await reportOf(intake, token);
  const file = await mongo.db.clientReportFiles.findFirst({
    _id: new ObjectId(fileId),
    reportId: report._id,
    state: { $in: STORED },
  });
  if (!file?.storageKey || !hasThumbnail(file)) throw fileNotFound();
  return { organisationId, storageKey: file.storageKey };
}

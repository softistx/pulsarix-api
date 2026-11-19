import { ObjectId } from "mongodb";
import { withoutMarkers } from "../comments/public";
import type { PublicState } from "../projects/public";
import { fileNotFound, reportNotFound } from "./intake.errors";
import {
  declineReasonShown,
  type ReportFileRole,
  type ReportState,
} from "./intake.model";
import { publicStateOf } from "./intake.publicstate";
import type { IntakeMongo, PublicIntake } from "./intake.submit";
import { parseTrackingToken } from "./intake.token";

// The tracking page's reads (the public side of the intake, intake.submit.ts):
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
async function reportOf(intake: PublicIntake, token: string) {
  const parsed = parseTrackingToken(token);
  if (!parsed) throw reportNotFound();
  const { tenancy } = intake.deps;
  const tenant = await tenancy.resolve(parsed.organisationId);
  if (!tenant) throw reportNotFound();
  const mongo = (await tenancy.databaseOf(tenant.id)) as unknown as IntakeMongo;
  const report = await mongo.db.clientReports.findFirst({
    trackingTokenHash: parsed.hash,
  });
  if (!report || report.erasedAt) throw reportNotFound();
  return { mongo, report, organisationId: parsed.organisationId };
}

// The tracking page's read: the state, the replies marked public, and the
// reporter's own files (name, role, whether a thumbnail exists). Nothing else
// of the report or its issue leaves (no author, no id, no private comment).
export async function trackedStatus(
  intake: PublicIntake,
  token: string,
  ip: string,
): Promise<Tracked> {
  await intake.limit((l) => l.intakeTrackingIp, { ip });
  const { mongo, report } = await reportOf(intake, token);
  const replies = report.issueId
    ? await mongo.db.comments.findMany({
        filter: { issueId: report.issueId, public: true },
        sort: { _id: 1 },
        limit: MAX_REPLIES,
      })
    : [];
  const files = await mongo.db.clientReportFiles.findMany({
    filter: { reportId: report._id, state: { $in: STORED } },
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

import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import { idOrInvalid } from "../../core/shared/ids";
import { issueNotFound } from "../issues/public";
import { fileKindName, pdfSize, previewSize } from "./intake.files.kinds";
import type { ClientReportFileDocument } from "./intake.model";
import type { IntakeMongo } from "./intake.reports";

// What the team reads of a report's files (A13). A file is listed once its
// bytes are stored: `quarantined` until its report is decided, `released` once
// the report is accepted. A declined report's files stay quarantined until the
// purge (intake.files.retention.ts).
const STORED = ["quarantined", "released"] as const;

// The routes of the bytes (intake.files.read.ts), relative to the API. The
// picture is its `full` rendition (the upload is never kept); a PDF is served
// under `file`.
const urlOf = (file: ClientReportFileDocument) =>
  `/media/${fileKindName}/${file.storageKey}/${
    file.mime === "application/pdf" ? pdfSize : "full"
  }`;
export const fileUrl = (file: ClientReportFileDocument) =>
  file.storageKey ? urlOf(file) : "";
export const filePreviewUrl = (file: ClientReportFileDocument) =>
  file.storageKey && file.previewKey
    ? `/media/${fileKindName}/${file.storageKey}/${previewSize}`
    : null;

// The stored files of a report, oldest first.
export function filesOfReport(
  mongo: IntakeMongo,
  reportId: ObjectId,
): Promise<ClientReportFileDocument[]> {
  return mongo.db.clientReportFiles.findMany({
    filter: { reportId, state: { $in: [...STORED] } },
    sort: { _id: 1 },
  });
}

// The files released to an issue from its report, oldest first; none for an
// issue that came from no report.
export async function releasedFilesOfIssue(
  mongo: IntakeMongo & ModuleMongo<"issues">,
  issueId: string,
): Promise<ClientReportFileDocument[]> {
  const id = idOrInvalid(issueId, "issueId");
  if (!(await mongo.db.issues.exists({ _id: id }))) throw issueNotFound();
  const report = await mongo.db.clientReports.findFirst({ issueId: id });
  if (!report) return [];
  return mongo.db.clientReportFiles.findMany({
    filter: { reportId: report._id, state: "released" },
    sort: { _id: 1 },
  });
}

// Releases a report's quarantined files to its issue: a state change in
// place, no copy and no new object, no record in the attachments (so they are
// outside the 20 per owner).
export async function releaseFiles(mongo: IntakeMongo, reportId: ObjectId) {
  await mongo.db.clientReportFiles.raw.updateMany(
    { reportId, state: "quarantined" },
    { $set: { state: "released", updatedAt: new Date() } },
  );
}

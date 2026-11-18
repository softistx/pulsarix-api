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

// How many files of each report are still to come: a slot reserved (`pending`)
// whose deadline has not passed, so the reporter's upload, or the scan that
// stores it as `quarantined`, is still ahead. One grouped read of the
// `reportId` index for a whole set of reports; a report with none is absent.
export async function pendingCountsOf(
  mongo: IntakeMongo,
  reportIds: readonly ObjectId[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (reportIds.length === 0) return counts;
  const rows = (await mongo.db.clientReportFiles.raw
    .aggregate([
      {
        $match: {
          reportId: { $in: [...reportIds] },
          state: "pending",
          $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
        },
      },
      { $group: { _id: "$reportId", count: { $sum: 1 } } },
    ])
    .toArray()) as Array<{ _id: ObjectId; count: number }>;
  for (const row of rows) counts.set(row._id.toHexString(), row.count);
  return counts;
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
    { reportId, state: "quarantined", expiresAt: null },
    { $set: { state: "released", updatedAt: new Date() } },
  );
}

// Releases the files a decided report still holds in quarantine: an accepted
// report (or one closed since) whose `releaseFiles` failed or lost a race. Run
// by the files retention job, so a failed release is retried within minutes.
// Files marked for removal (their issue was deleted) are left to the purge.
// Idempotent; answers how many reports it released files of.
export async function releaseStranded(mongo: IntakeMongo): Promise<number> {
  const held = (await mongo.db.clientReportFiles.raw.distinct("reportId", {
    state: "quarantined",
    expiresAt: null,
  })) as ObjectId[];
  if (held.length === 0) return 0;
  const reports = (await mongo.db.clientReports.raw
    .find(
      { _id: { $in: held }, state: { $in: ["accepted", "closed"] } },
      { projection: { _id: 1 } },
    )
    .toArray()) as Array<{ _id: ObjectId }>;
  for (const report of reports) {
    await releaseFiles(mongo, report._id);
  }
  return reports.length;
}

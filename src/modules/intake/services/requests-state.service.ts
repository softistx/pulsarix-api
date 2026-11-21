import type { ObjectId } from "mongodb";
import { type PublicState, publicStateOfStatus } from "../../projects/public";
import type { ClientReportDocument } from "../models";
import { derivePublicState } from "./public-state.service";
import type { IntakeMongo } from "./submit.service";

// The public state and the unread count of many reports at once (plan §19):
// the lists of "My requests" and the live stream read them for a whole
// reporter, so they are batched (one read of the issues, one of the statuses,
// one of the public comments) instead of asked report by report.

export async function publicStatesOf(
  mongo: IntakeMongo,
  reports: readonly ClientReportDocument[],
): Promise<Map<string, PublicState>> {
  const issueIds = [
    ...new Set(
      reports.flatMap((report) =>
        report.issueId ? [report.issueId.toHexString()] : [],
      ),
    ),
  ];
  const issues = issueIds.length
    ? await mongo.db.issues.findMany({
        filter: { _id: { $in: reports.flatMap((r) => r.issueId ?? []) } },
        limit: issueIds.length,
      })
    : [];
  const statusIds = [...new Set(issues.map((i) => i.statusId.toHexString()))];
  const statuses = statusIds.length
    ? await mongo.db.statuses.findMany({
        filter: { _id: { $in: issues.map((issue) => issue.statusId) } },
        limit: statusIds.length,
      })
    : [];
  const mappedOfStatus = new Map(
    statuses.map((status) => [status.id, publicStateOfStatus(status)]),
  );
  const mappedOfIssue = new Map(
    issues.map((issue) => [
      issue.id,
      mappedOfStatus.get(issue.statusId.toHexString()) ?? null,
    ]),
  );
  return new Map(
    reports.map((report) => [
      report.id,
      derivePublicState(
        report,
        report.issueId
          ? (mappedOfIssue.get(report.issueId.toHexString()) ?? null)
          : null,
      ),
    ]),
  );
}

// The team's public replies each report has not read: those after its read
// cursor (and after its link, for a linked report), counted in memory from the
// public comments of all the issues in one read.
export async function unreadOf(
  mongo: IntakeMongo,
  reports: readonly ClientReportDocument[],
): Promise<Map<string, number>> {
  const counts = new Map(reports.map((report) => [report.id, 0]));
  const linked = reports.filter((report) => report.issueId);
  if (linked.length === 0) return counts;
  const issueIds: ObjectId[] = linked.flatMap((report) => report.issueId ?? []);
  const rows = (await mongo.db.comments.raw
    .aggregate([
      { $match: { issueId: { $in: issueIds }, public: true } },
      { $group: { _id: "$issueId", times: { $push: "$createdAt" } } },
    ])
    .toArray()) as { _id: ObjectId; times: Date[] }[];
  const timesOf = new Map(
    rows.map((row) => [row._id.toHexString(), row.times]),
  );
  for (const report of linked) {
    const since = Math.max(
      report.linkedAt?.getTime() ?? 0,
      report.reporterReadAt?.getTime() ?? 0,
    );
    const times = timesOf.get(report.issueId?.toHexString() ?? "") ?? [];
    counts.set(report.id, times.filter((at) => at.getTime() > since).length);
  }
  return counts;
}

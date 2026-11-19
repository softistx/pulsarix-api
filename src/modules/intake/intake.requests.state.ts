import type { ObjectId } from "mongodb";
import { type PublicState, publicStateOfStatus } from "../projects/public";
import type { ClientReportDocument } from "./intake.model";
import { derivePublicState } from "./intake.publicstate";
import type { IntakeMongo } from "./intake.submit";

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

// A per-request loader for one report's public state: the calls made in the
// same tick (one per report of a list) share one batched read.
type StateLoader = (report: ClientReportDocument) => Promise<PublicState>;
const loaders = new WeakMap<object, StateLoader>();

export function publicStateLoaderOf(
  key: object,
  mongo: IntakeMongo,
): StateLoader {
  const known = loaders.get(key);
  if (known) return known;
  let queue: {
    report: ClientReportDocument;
    resolve: (state: PublicState) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const flush = async () => {
    const batch = queue;
    queue = [];
    try {
      const states = await publicStatesOf(
        mongo,
        batch.map((entry) => entry.report),
      );
      for (const { report, resolve } of batch) {
        resolve(states.get(report.id) ?? "received");
      }
    } catch (error) {
      for (const { reject } of batch) reject(error);
    }
  };
  const load: StateLoader = (report) =>
    new Promise((resolve, reject) => {
      if (queue.length === 0) setTimeout(flush, 0);
      queue.push({ report, resolve, reject });
    });
  loaders.set(key, load);
  return load;
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

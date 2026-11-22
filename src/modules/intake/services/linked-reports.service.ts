import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import type { ClientReportDocument } from "../models";

type LinkMongo = ModuleMongo<"intake">;

const LIMIT = 1_000;

// The requests linked to an issue (A23), by their links; a report stored
// before the links also counts through its `issueId`. `filter` narrows them.
export async function reportsOfIssue(
  mongo: LinkMongo,
  issueId: ObjectId,
  filter: Record<string, unknown> = {},
): Promise<ClientReportDocument[]> {
  const links = await mongo.db.clientReportLinks.findMany({
    filter: { issueId },
    limit: LIMIT,
  });
  return mongo.db.clientReports.findMany({
    filter: {
      $or: [{ _id: { $in: links.map((link) => link.reportId) } }, { issueId }],
      ...filter,
    },
    limit: LIMIT,
  });
}

// The issues each report is linked to, in link order. A report with no link
// row yet falls back to its `issueId`, the first link.
export async function linkedIssueIds(
  mongo: LinkMongo,
  reports: readonly Pick<ClientReportDocument, "_id" | "id" | "issueId">[],
): Promise<Map<string, ObjectId[]>> {
  const found = new Map<string, ObjectId[]>(
    reports.map((report) => [report.id, []]),
  );
  if (reports.length === 0) return found;
  const links = await mongo.db.clientReportLinks.findMany({
    filter: { reportId: { $in: reports.map((report) => report._id) } },
    sort: { _id: 1 },
    limit: reports.length * LIMIT,
  });
  for (const link of links)
    found.get(link.reportId.toHexString())?.push(link.issueId);
  for (const report of reports) {
    const ids = found.get(report.id);
    if (ids && ids.length === 0 && report.issueId) ids.push(report.issueId);
  }
  return found;
}

// The requests of many issues at once, erased ones left out, keyed by the
// issue's hex id: one read of the links, one of the reports.
export async function reportsOfIssues(
  mongo: LinkMongo,
  issueIds: readonly ObjectId[],
): Promise<Map<string, ClientReportDocument[]>> {
  const found = new Map<string, ClientReportDocument[]>(
    issueIds.map((id) => [id.toHexString(), []]),
  );
  if (issueIds.length === 0) return found;
  const links = await mongo.db.clientReportLinks.findMany({
    filter: { issueId: { $in: [...issueIds] } },
    sort: { _id: 1 },
    limit: issueIds.length * LIMIT,
  });
  const reports = await mongo.db.clientReports.findMany({
    filter: {
      $or: [
        { _id: { $in: links.map((link) => link.reportId) } },
        { issueId: { $in: [...issueIds] } },
      ],
      erasedAt: null,
    },
    sort: { _id: 1 },
    limit: issueIds.length * LIMIT,
  });
  const linkedTo = new Map<string, Set<string>>();
  for (const link of links) {
    const key = link.reportId.toHexString();
    linkedTo.set(
      key,
      (linkedTo.get(key) ?? new Set()).add(link.issueId.toHexString()),
    );
  }
  for (const report of reports) {
    const own = new Set(linkedTo.get(report.id));
    if (report.issueId) own.add(report.issueId.toHexString());
    for (const id of own) found.get(id)?.push(report);
  }
  return found;
}

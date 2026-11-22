import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import type { IssueDocument } from "../../issues/public";
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

// One issue a request is linked to, and the date from which its reporter reads
// the issue's public comments (they never see what was said before the link).
export interface ReportLink {
  issueId: ObjectId;
  since: Date | null;
}

// The links of each report, in link order, with their dates. A report with no
// link row yet falls back to its `issueId`, since its own link date.
export async function linksOf(
  mongo: LinkMongo,
  reports: readonly Pick<
    ClientReportDocument,
    "_id" | "id" | "issueId" | "linkedAt"
  >[],
): Promise<Map<string, ReportLink[]>> {
  const found = new Map<string, ReportLink[]>(
    reports.map((report) => [report.id, []]),
  );
  if (reports.length === 0) return found;
  const links = await mongo.db.clientReportLinks.findMany({
    filter: { reportId: { $in: reports.map((report) => report._id) } },
    sort: { _id: 1 },
    limit: reports.length * LIMIT,
  });
  for (const link of links) {
    found
      .get(link.reportId.toHexString())
      ?.push({ issueId: link.issueId, since: link.linkedAt });
  }
  for (const report of reports) {
    const own = found.get(report.id);
    if (own && own.length === 0 && report.issueId) {
      own.push({ issueId: report.issueId, since: report.linkedAt ?? null });
    }
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

// Runs `each` on every live issue a request is linked to, in link order (the
// one loop the settling, the messages and the retention share).
export async function eachLinkedIssue(
  tx: LinkMongo & ModuleMongo<"issues">,
  report: Pick<ClientReportDocument, "_id" | "id" | "issueId">,
  each: (issue: IssueDocument) => Promise<void>,
): Promise<void> {
  const linked = (await linkedIssueIds(tx, [report])).get(report.id);
  for (const issueId of linked ?? []) {
    const issue = await tx.db.issues.findById(issueId);
    if (issue) await each(issue);
  }
}

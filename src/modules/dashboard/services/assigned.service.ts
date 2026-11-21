import type { ObjectId } from "mongodb";
import { invalid } from "../../../core/shared/errors";
import { after, decode, encode, lateOf } from "../dashboard.utils";
import type { DashboardParent } from "./base.service";

export const DEFAULT_FIRST = 8;
const MAX_FIRST = 100;

interface Row {
  _id: ObjectId;
  late: number;
  priorityLevel: number;
  updatedAt: Date;
}

// The viewer's open issues of the active projects: late first, then the higher
// priority, then the most recently updated, `first` at a time.
export async function assignedPage(
  parent: DashboardParent,
  first: number,
  cursor: string | null | undefined,
) {
  if (!Number.isInteger(first) || first < 1 || first > MAX_FIRST) {
    throw invalid([{ path: "first", code: "validation.errors.out-of-range" }]);
  }
  const position = cursor ? decode(cursor, parent.today) : null;
  const base = await parent.base();
  const empty = {
    nodes: [],
    totalCount: 0,
    lateCount: 0,
    endCursor: null,
    hasNextPage: false,
  };
  if (base.openIds.length === 0) return empty;

  const match = {
    assigneeId: parent.viewerId,
    statusId: { $in: base.openIds },
  };
  const late = lateOf(parent.startOfToday);
  const issues = parent.mongo.db.issues;
  const [rows, totals] = await Promise.all([
    issues.raw
      .aggregate([
        { $match: match },
        { $addFields: { late } },
        ...(position ? [{ $match: after(position) }] : []),
        { $sort: { late: -1, priorityLevel: -1, updatedAt: -1, _id: -1 } },
        { $limit: first + 1 },
        { $project: { late: 1, priorityLevel: 1, updatedAt: 1 } },
      ])
      .toArray() as Promise<Row[]>,
    issues.raw
      .aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: 1 }, late: { $sum: late } } },
      ])
      .toArray() as Promise<{ total: number; late: number }[]>,
  ]);
  const page = rows.slice(0, first);
  const found = await issues.findMany({
    filter: { _id: { $in: page.map((r) => r._id) } } as never,
  });
  const byId = new Map(found.map((issue) => [issue.id, issue]));
  const projects = new Map(base.projects.map((p) => [p._id.toHexString(), p]));
  const nodes = page.flatMap((row) => {
    const issue = byId.get(row._id.toHexString());
    const status = issue && base.statuses.get(issue.statusId.toHexString());
    const project = issue && projects.get(issue.projectId.toHexString());
    return issue && status && project
      ? [{ issue, status, projectKey: project.key, late: row.late === 1 }]
      : [];
  });
  const last = page.at(-1);
  const hasNextPage = rows.length > first;
  return {
    nodes,
    totalCount: totals[0]?.total ?? 0,
    lateCount: totals[0]?.late ?? 0,
    endCursor:
      hasNextPage && last
        ? encode([
            last.late,
            last.priorityLevel,
            last.updatedAt.getTime(),
            last._id.toHexString(),
            parent.today,
          ])
        : null,
    hasNextPage,
  };
}

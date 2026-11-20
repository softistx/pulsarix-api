import type { ObjectId } from "mongodb";
import type { Base, DashboardParent } from "./dashboard.base";

// 1 when the issue has a due date before `start` (the start of today), else 0.
// A missing or null date is never late.
export const lateOf = (start: Date) => ({
  $cond: [
    { $and: [{ $gt: ["$dueDate", null] }, { $lt: ["$dueDate", start] }] },
    1,
    0,
  ],
});

const count = (test: object) => ({ $sum: { $cond: [test, 1, 0] } });

// One pass over the open issues of the projects, per project. Everything it
// reads (project, status, priority, due date) is in the
// `issues_projectIdStatusIdPriorityDue` index, so no document is fetched.
export const figuresPipeline = (
  projectIds: ObjectId[],
  openIds: ObjectId[],
  triageIds: ObjectId[],
  start: Date,
) => [
  { $match: { projectId: { $in: projectIds }, statusId: { $in: openIds } } },
  {
    $group: {
      _id: "$projectId",
      open: { $sum: 1 },
      urgent: count({ $eq: ["$priorityLevel", 4] }),
      late: { $sum: lateOf(start) },
      triage: count({ $in: ["$statusId", triageIds] }),
    },
  },
];

interface Row {
  _id: ObjectId;
  open: number;
  urgent: number;
  late: number;
  triage: number;
}

// One aggregation per request, shared by `projects` and `triage`.
const cached = new WeakMap<DashboardParent, Promise<Map<string, Row>>>();

function rowsOf(parent: DashboardParent, base: Base) {
  let rows = cached.get(parent);
  if (!rows) {
    rows = readRows(parent, base);
    cached.set(parent, rows);
  }
  return rows;
}

async function readRows(parent: DashboardParent, base: Base) {
  if (base.openIds.length === 0) return new Map<string, Row>();
  const pipeline = figuresPipeline(
    base.projects.map((p) => p._id),
    base.openIds,
    base.triageIds,
    parent.startOfToday,
  );
  const rows = (await parent.mongo.db.issues.raw
    .aggregate(pipeline)
    .toArray()) as Row[];
  return new Map(rows.map((row) => [row._id.toHexString(), row]));
}

// Every active project with its figures, zeros included, by name.
export async function projectFigures(parent: DashboardParent) {
  const base = await parent.base();
  const rows = await rowsOf(parent, base);
  return base.projects.map((project) => {
    const row = rows.get(project.id);
    return {
      project,
      open: row?.open ?? 0,
      urgent: row?.urgent ?? 0,
      late: row?.late ?? 0,
    };
  });
}

// The projects with a triage issue or a new client report.
export async function triageBacklog(parent: DashboardParent) {
  const base = await parent.base();
  const rows = await rowsOf(parent, base);
  const reports = (await parent.mongo.db.clientReports.raw
    .aggregate([
      {
        $match: {
          projectId: { $in: base.projects.map((p) => p._id) },
          state: "new",
        },
      },
      { $group: { _id: "$projectId", n: { $sum: 1 } } },
    ])
    .toArray()) as { _id: ObjectId; n: number }[];
  const newReports = new Map(reports.map((r) => [r._id.toHexString(), r.n]));
  return base.projects
    .map((project) => ({
      project,
      issues: rows.get(project.id)?.triage ?? 0,
      newReports: newReports.get(project.id) ?? 0,
    }))
    .filter((row) => row.issues > 0 || row.newReports > 0);
}

import type { ObjectId } from "mongodb";
import { figuresPipeline } from "../dashboard.utils";
import type { Base, DashboardParent } from "./base.service";

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

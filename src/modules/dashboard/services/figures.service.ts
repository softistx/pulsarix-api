import type { ObjectId } from "mongodb";
import type { DashboardParent } from "./base.service";

// Every active project with its figures, zeros included, by name.
export async function projectFigures(parent: DashboardParent) {
  const base = await parent.base();
  const rows = await parent.rows();
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
  const rows = await parent.rows();
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

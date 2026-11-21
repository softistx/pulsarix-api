import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import type { ProjectDocument, StatusDocument } from "../../projects/public";
import { figuresPipeline } from "../dashboard.utils";

export type DashboardMongo = ModuleMongo<"dashboard">;

// What every section reads first: the active projects (by name) and their
// statuses, split into the open ones (not done, not cancelled) and the triage
// ones. Read once per request, by the first section that asks.
export interface Base {
  projects: ProjectDocument[];
  statuses: Map<string, StatusDocument>;
  openIds: ObjectId[];
  triageIds: ObjectId[];
}

// What one project shows on the dashboard: its open, urgent, late and triage
// issues.
export interface FigureRow {
  _id: ObjectId;
  open: number;
  urgent: number;
  late: number;
  triage: number;
}

// The parent of the `Dashboard` fields: the request's scope and the day.
export interface DashboardParent {
  mongo: DashboardMongo;
  viewerId: string;
  timeZone: string;
  today: string;
  startOfToday: Date;
  base: () => Promise<Base>;
  // The figures of every project, by project id; one aggregation per request,
  // shared by `projects` and `triage`.
  rows: () => Promise<Map<string, FigureRow>>;
}

async function readBase(mongo: DashboardMongo): Promise<Base> {
  const found = await mongo.db.projects.findMany({
    filter: { archivedAt: null },
  });
  const projects = found.sort((a, b) => a.name.localeCompare(b.name));
  const list = await mongo.db.statuses.findMany({
    filter: { projectId: { $in: projects.map((p) => p._id) } } as never,
  });
  const open = list.filter(
    (s) => s.category !== "done" && s.category !== "cancelled",
  );
  return {
    projects,
    statuses: new Map(list.map((s) => [s.id, s])),
    openIds: open.map((s) => s._id),
    triageIds: open.filter((s) => s.category === "triage").map((s) => s._id),
  };
}

async function readRows(
  scope: Omit<DashboardParent, "base" | "rows">,
  base: Base,
): Promise<Map<string, FigureRow>> {
  if (base.openIds.length === 0) return new Map();
  const pipeline = figuresPipeline(
    base.projects.map((p) => p._id),
    base.openIds,
    base.triageIds,
    scope.startOfToday,
  );
  const rows = (await scope.mongo.db.issues.raw
    .aggregate(pipeline)
    .toArray()) as FigureRow[];
  return new Map(rows.map((row) => [row._id.toHexString(), row]));
}

export function dashboardParent(
  scope: Omit<DashboardParent, "base" | "rows">,
): DashboardParent {
  let base: Promise<Base> | undefined;
  let rows: Promise<Map<string, FigureRow>> | undefined;
  const readBaseOnce = () => (base ??= readBase(scope.mongo));
  return {
    ...scope,
    base: readBaseOnce,
    rows: () => (rows ??= readBaseOnce().then((b) => readRows(scope, b))),
  };
}

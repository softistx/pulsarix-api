import type { ModuleMongo } from "../../../config/db";
import type { Base, FigureRow } from "../dashboard.types";
import { baseOf, byName, figuresPipeline, rowsById } from "../dashboard.utils";

export type { Base };

export type DashboardMongo = ModuleMongo<"dashboard">;

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
  const projects = byName(found);
  const list = await mongo.db.statuses.findMany({
    filter: { projectId: { $in: projects.map((p) => p._id) } } as never,
  });
  return baseOf(projects, list);
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
  return rowsById(rows);
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

import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { ProjectDocument, StatusDocument } from "../projects/public";

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

// The parent of the `Dashboard` fields: the request's scope and the day.
export interface DashboardParent {
  mongo: DashboardMongo;
  viewerId: string;
  timeZone: string;
  today: string;
  startOfToday: Date;
  base: () => Promise<Base>;
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

export function dashboardParent(
  scope: Omit<DashboardParent, "base">,
): DashboardParent {
  let base: Promise<Base> | undefined;
  return { ...scope, base: () => (base ??= readBase(scope.mongo)) };
}

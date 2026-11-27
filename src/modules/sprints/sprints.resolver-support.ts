import { requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import {
  SprintLifecycle,
  SprintPlanning,
  SprintReports,
  SprintsProject,
  SprintsService,
} from "./services";

export type Permission = "sprint:read" | "sprint:write";

// The services of the request's organisation, once the guard let the viewer in.
export async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewer = requireViewer(ctx);
  const project = new SprintsProject(
    mongo,
    viewer.id,
    tenant._id.toHexString(),
    tenant.timeZone,
  );
  return {
    sprints: new SprintsService(project),
    lifecycle: new SprintLifecycle(project),
    planning: new SprintPlanning(project),
    reports: new SprintReports(project),
  };
}

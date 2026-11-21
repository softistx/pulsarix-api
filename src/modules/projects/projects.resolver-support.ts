import { requirePermission } from "../../core/access";
import type { Context } from "../../http/context";
import { LabelsService, ProjectsService, StatusesService } from "./services";

// The services of the request's organisation, once the guard let the viewer in.
async function scoped(
  ctx: Context,
  permission: "project:read" | "project:manage",
) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  return {
    projects: new ProjectsService(
      mongo,
      async (accountId) =>
        (await ctx.services.roleOf(tenant._id.toHexString(), accountId)) !==
        null,
    ),
    statuses: new StatusesService(mongo),
    labels: new LabelsService(mongo),
  };
}

export const reader = (ctx: Context) => scoped(ctx, "project:read");
export const manager = (ctx: Context) => scoped(ctx, "project:manage");

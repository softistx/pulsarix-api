import { requirePermission, requireViewer } from "../../../core/access";
import type { Context } from "../../../http/context";
import { IssuesService } from "../services";

export type Permission = "issue:read" | "issue:write" | "issue:delete";

// The service of the request's organisation, once the guard let the viewer in.
export async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewerId = requireViewer(ctx).id;
  return {
    viewerId,
    mongo,
    issues: new IssuesService(
      mongo,
      async (accountId) =>
        (await ctx.services.roleOf(tenant._id.toHexString(), accountId)) !==
        null,
      viewerId,
      tenant._id.toHexString(),
    ),
  };
}

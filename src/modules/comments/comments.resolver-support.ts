import { can, requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { CommentsService } from "./comments.service";

type Permission = "comment:read" | "comment:write";

// The service of the request's organisation, once the guard let the viewer in.
// An admin or an owner (`comment:delete`) may change others' comments.
export async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewer = requireViewer(ctx);
  const organisationId = tenant._id.toHexString();
  return new CommentsService(
    mongo,
    async (accountId) =>
      (await ctx.services.roleOf(organisationId, accountId)) !== null,
    viewer.id,
    await can(ctx, "comment:delete"),
    organisationId,
  );
}

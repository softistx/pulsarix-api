import { can, requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { AttachmentsService } from "./attachments.service";

type Permission = "attachment:read" | "attachment:write";

export async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewer = requireViewer(ctx);
  return new AttachmentsService(
    mongo,
    viewer.id,
    await can(ctx, "attachment:delete"),
    tenant._id.toHexString(),
  );
}

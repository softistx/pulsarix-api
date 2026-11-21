import type { Context } from "../../http/context";
import { requirePermission, requireViewer } from "../access";

// The invitations service once the viewer manages members (`member:manage`).
export async function managerServices(ctx: Context) {
  const { tenant, member } = await requirePermission(ctx, "member:manage");
  const viewer = requireViewer(ctx);
  // Inviting with a role is a promotion: it asks for the same recent proof.
  ctx.services.requireFresh(viewer);
  return ctx.services.invitations(tenant, member, viewer.id);
}

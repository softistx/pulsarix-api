import type { Context } from "../../http/context";
import { requirePermission, requireViewer } from "../access";

// The invitations service once the viewer manages members (`member:manage`),
// for reading the pending invitations: no promotion, so no fresh proof.
export async function readerServices(ctx: Context) {
  const { tenant, member } = await requirePermission(ctx, "member:manage");
  return ctx.services.invitations(tenant, member, requireViewer(ctx).id);
}

// The same, for inviting, resending and revoking. Inviting with a role is a
// promotion: it asks for a recent proof of identity.
export async function managerServices(ctx: Context) {
  const { tenant, member } = await requirePermission(ctx, "member:manage");
  const viewer = requireViewer(ctx);
  ctx.services.requireFresh(viewer);
  return ctx.services.invitations(tenant, member, viewer.id);
}

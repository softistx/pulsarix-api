import type { Context } from "../../http/context";
import { requirePermission, requireViewer } from "../access";
import { invalid } from "../shared/errors";

// A janus account id is a UUID; anything else names no member (400 on `id`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idOrInvalidAccount(given: string, path = "id") {
  if (!UUID.test(given)) {
    throw invalid([{ path, code: "validation.errors.invalid" }]);
  }
  return given.toLowerCase();
}

// The members service once the viewer manages them (`member:manage`) with a
// recent proof of identity: what every mutation of the module calls first.
export async function managerServices(ctx: Context) {
  const { tenant } = await requirePermission(ctx, "member:manage");
  const viewer = requireViewer(ctx);
  ctx.services.requireFresh(viewer);
  return ctx.services.members(tenant, viewer.id);
}

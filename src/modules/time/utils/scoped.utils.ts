import { requirePermission, requireViewer } from "../../../core/access";
import type { Context } from "../../../http/context";
import { issueTotals, TimeLink, TimeTracking } from "../services";

export type Permission = "time:read" | "time:write" | "time:manage";

export async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  const viewer = requireViewer(ctx);
  const link = new TimeLink(mongo, tenant._id.toHexString());
  return {
    link,
    tracking: new TimeTracking(mongo, link, viewer.email, viewer.emailVerified),
    totals: (issueIds: readonly string[]) =>
      issueTotals(link, viewer.email, viewer.emailVerified, issueIds),
  };
}

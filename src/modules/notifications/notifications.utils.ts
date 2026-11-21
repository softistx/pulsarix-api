import { requireMember, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { NotificationsService } from "./services";

// The viewer's own notifications, once the guard let them in: any member has
// an inbox, whatever their role.
export async function scoped(ctx: Context) {
  const { mongo } = await requireMember(ctx);
  return new NotificationsService(mongo, requireViewer(ctx).id);
}

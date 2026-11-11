import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { NotificationsService } from "./notifications.service";

// The viewer's own notifications, once the guard let them in: any member has
// an inbox, whatever their role.
async function scoped(ctx: Context) {
  const { mongo } = await requireMember(ctx);
  return new NotificationsService(mongo, requireViewer(ctx).id);
}

export const notificationsResolvers: Resolvers = {
  Query: {
    notifications: async (_, { unread, first, after }, ctx) =>
      (await scoped(ctx)).list(unread, first, after),
    unreadNotificationCount: async (_, __, ctx) =>
      (await scoped(ctx)).unreadCount(),
  },
  Mutation: {
    markNotificationsRead: async (_, { ids }, ctx) =>
      (await scoped(ctx)).markRead(ids),
  },
  Notification: {
    id: (notification) => notification.id,
    activityId: (notification) => notification.activityId.toHexString(),
    projectId: (notification) => notification.projectId.toHexString(),
    issueId: (notification) => notification.issueId.toHexString(),
    commentId: (notification) => notification.commentId?.toHexString() ?? null,
  },
};

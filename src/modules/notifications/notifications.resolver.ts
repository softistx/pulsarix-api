import type { Resolvers } from "@/generated/graphql/resolvers";
import { scoped } from "./notifications.utils";

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

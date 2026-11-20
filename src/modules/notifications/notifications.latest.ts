import type { NotificationsMongo } from "./notifications.service";

// Only the notifications collection: Home reads it from a module that depends
// on notifications but not on the modules it writes through.
export interface NotificationsRead {
  db: { notifications: NotificationsMongo["db"]["notifications"] };
}

// The viewer's unread count and their newest unread notifications, or the
// newest of all when none is unread (Home's inbox).
export async function latestNotifications(
  mongo: NotificationsRead,
  viewerId: string,
  limit: number,
) {
  const { notifications } = mongo.db;
  const unread = await notifications.count({
    recipientId: viewerId,
    readAt: null,
  });
  const latest = await notifications.findMany({
    filter: { recipientId: viewerId, ...(unread > 0 && { readAt: null }) },
    sort: { _id: -1 },
    limit,
  });
  return { unread, latest };
}

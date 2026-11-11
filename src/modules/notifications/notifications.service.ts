import type { ModuleMongo } from "../../config/db";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import type { NotificationDocument } from "./notifications.model";

export type NotificationsMongo = ModuleMongo<"notifications">;

export const MAX_PAGE = 100;
export const MAX_IDS = 200;

export interface NotificationPage {
  nodes: NotificationDocument[];
  endCursor: string | null;
  hasNextPage: boolean;
}

// The viewer's own notifications: every read and write is filtered by
// `recipientId`, so a member never sees or marks another's.
export class NotificationsService {
  constructor(
    private readonly mongo: NotificationsMongo,
    private readonly viewerId: string,
  ) {}

  unreadCount(): Promise<number> {
    return this.mongo.db.notifications.count({
      recipientId: this.viewerId,
      readAt: null,
    });
  }

  // Newest first, paged by cursor; `unread` keeps the ones not yet read.
  async list(
    unread: boolean | null | undefined,
    first: number | null | undefined,
    after?: string | null,
  ): Promise<NotificationPage> {
    const limit = first ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw invalid([
        { path: "first", code: "validation.errors.out-of-range" },
      ]);
    }
    const cursor = after ? idOrInvalid(after, "after") : null;
    const found = await this.mongo.db.notifications.findMany({
      filter: {
        recipientId: this.viewerId,
        ...(unread && { readAt: null }),
        ...(cursor && { _id: { $lt: cursor } }),
      },
      sort: { _id: -1 },
      limit: limit + 1,
    });
    const nodes = found.slice(0, limit);
    const last = nodes.at(-1);
    const hasNextPage = found.length > limit;
    return {
      nodes,
      endCursor: hasNextPage && last ? last.id : null,
      hasNextPage,
    };
  }

  // Reads `ids` (the viewer's own; an unknown or foreign id is ignored), or
  // every unread one when none are given. Answers the unread count left.
  async markRead(ids: readonly string[] | null | undefined): Promise<number> {
    if (ids && ids.length > MAX_IDS) {
      throw invalid([{ path: "ids", code: "validation.errors.out-of-range" }]);
    }
    const objectIds = ids?.map((id) => idOrInvalid(id, "ids"));
    await this.mongo.db.notifications.updateMany(
      {
        recipientId: this.viewerId,
        readAt: null,
        ...(objectIds && { _id: { $in: objectIds } }),
      },
      { readAt: new Date() },
    );
    return this.unreadCount();
  }
}

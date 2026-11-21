import { invalid } from "../../../core/shared/errors";
import { latestNotifications } from "../../notifications/public";
import type { DashboardParent } from "./base.service";

export const DEFAULT_LATEST = 5;
const MAX_LATEST = 20;

// The viewer's unread count and their newest unread notifications (the newest
// of all when none is unread).
export function inboxOf(parent: DashboardParent, latest: number) {
  if (!Number.isInteger(latest) || latest < 1 || latest > MAX_LATEST) {
    throw invalid([{ path: "latest", code: "validation.errors.out-of-range" }]);
  }
  return latestNotifications(parent.mongo, parent.viewerId, latest);
}

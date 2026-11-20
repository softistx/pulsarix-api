import type { Resolvers } from "@/generated/graphql/resolvers";
import {
  can,
  requireMember,
  requirePermission,
  requireViewer,
} from "../../core/access";
import { dayIn, startOfDayIn } from "../../core/shared/days";
import { assignedPage, DEFAULT_FIRST } from "./dashboard.assigned";
import { dashboardParent } from "./dashboard.base";
import { projectFigures, triageBacklog } from "./dashboard.figures";
import { DEFAULT_LATEST, inboxOf } from "./dashboard.inbox";

export const dashboardResolvers: Resolvers = {
  Query: {
    dashboard: async (_, __, ctx) => {
      const { mongo, tenant } = await requireMember(ctx);
      const now = new Date();
      return dashboardParent({
        mongo: mongo as never,
        viewerId: requireViewer(ctx).id,
        timeZone: tenant.timeZone,
        today: dayIn(tenant.timeZone, now),
        startOfToday: startOfDayIn(tenant.timeZone, now),
      });
    },
  },
  Dashboard: {
    assigned: async (parent, { first, after }, ctx) => {
      await requirePermission(ctx, "issue:read");
      return assignedPage(parent, first ?? DEFAULT_FIRST, after) as never;
    },
    inbox: (parent, { latest }) =>
      inboxOf(parent, latest ?? DEFAULT_LATEST) as never,
    projects: async (parent, _, ctx) => {
      await requirePermission(ctx, "project:read");
      await requirePermission(ctx, "issue:read");
      return projectFigures(parent);
    },
    triage: async (parent, _, ctx) =>
      (await can(ctx, "issue:write")) ? triageBacklog(parent) : null,
  },
};

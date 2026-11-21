import type { Resolvers } from "@/generated/graphql/resolvers";
import { requirePermission } from "../../core/access";
import {
  openClientReportFiles,
  openClientReportMessages,
  openClientReports,
  openIssueChanged,
  openNotifications,
  openProjectBoard,
} from "./activity.resolver-support";
import { issueEvent } from "./activity.utils";
import { ActivityService } from "./services";

export const activityResolvers: Resolvers = {
  Query: {
    activity: async (_, { projectId, issueId, first, after }, ctx) => {
      const { mongo } = await requirePermission(ctx, "issue:read");
      return new ActivityService(mongo).list(
        { projectId, issueId },
        first,
        after,
      );
    },
  },
  Activity: {
    id: (activity) => activity.id,
    projectId: (activity) => activity.projectId.toHexString(),
    issueId: (activity) => activity.issueId?.toHexString() ?? null,
  },
  Subscription: {
    projectBoard: {
      subscribe: (_, { projectId }, ctx) => openProjectBoard(ctx, projectId),
      resolve: issueEvent as never,
    },
    issueChanged: {
      subscribe: (_, { issueId }, ctx) => openIssueChanged(ctx, issueId),
      resolve: issueEvent as never,
    },
    notificationReceived: {
      subscribe: (_, __, ctx) => openNotifications(ctx),
      resolve: ((event: { [key: string]: unknown }) => event) as never,
    },
    clientReportReceived: {
      subscribe: (_, { projectId }, ctx) => openClientReports(ctx, projectId),
      resolve: issueEvent as never,
    },
    clientReportFileReceived: {
      subscribe: (_, { projectId }, ctx) =>
        openClientReportFiles(ctx, projectId),
      resolve: issueEvent as never,
    },
    clientReportMessageReceived: {
      subscribe: (_, { projectId }, ctx) =>
        openClientReportMessages(ctx, projectId),
      resolve: issueEvent as never,
    },
  },
};

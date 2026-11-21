import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireViewer } from "../../core/access";
import type { TimeSpentView } from "./services";
import { isOnIssue, myTimer, scoped, spent } from "./utils";

export const timeResolvers: Resolvers = {
  Query: {
    timeLink: async (_, __, ctx) =>
      (await scoped(ctx, "time:read")).link.status(),
  },
  Mutation: {
    // Sensitive, like the widget keys: a fresh session (step-up) is required.
    linkChronix: async (_, { key }, ctx) => {
      const { link } = await scoped(ctx, "time:manage");
      ctx.services.requireFresh(requireViewer(ctx));
      return link.link(key);
    },
    unlinkChronix: async (_, __, ctx) => {
      const { link } = await scoped(ctx, "time:manage");
      ctx.services.requireFresh(requireViewer(ctx));
      return link.unlink();
    },
    startIssueTimer: async (_, { issueId }, ctx) =>
      (await scoped(ctx, "time:write")).tracking.startTimer(issueId),
    stopIssueTimer: async (_, { issueId }, ctx) =>
      (await scoped(ctx, "time:write")).tracking.stopTimer(issueId),
    logIssueTime: async (_, { issueId, input }, ctx) =>
      (await scoped(ctx, "time:write")).tracking.logTime(issueId, input),
  },
  TimeSpent: {
    myRunningTimer: async (parent, _, ctx) => {
      const timer = await myTimer(ctx);
      if (!timer || !isOnIssue(timer, parent.issueId)) return null;
      return { startedAt: timer.startedAt, stoppedSeconds: null };
    },
  },
  Issue: {
    // Degrades to a status, whatever chronix does; the issue query never fails
    // because of it.
    timeSpent: async (issue, _, ctx) => {
      const view = await spent(ctx, issue.id).catch(
        (): TimeSpentView => ({ status: "UNAVAILABLE" }),
      );
      return {
        status: view.status,
        totalSeconds: "totalSeconds" in view ? view.totalSeconds : null,
        mySeconds: "mySeconds" in view ? view.mySeconds : null,
        entryCount: "entryCount" in view ? view.entryCount : null,
        running: "running" in view ? view.running : null,
        issueId: issue.id,
      };
    },
  },
};

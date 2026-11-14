import type { LinkTimer } from "@softistx/chronix-react/server";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { can, requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { TimeLink } from "./time.link";
import { isOnIssue } from "./time.ref";
import { issueTotals, type TimeSpentView } from "./time.totals";
import { TimeTracking } from "./time.tracking";

type Permission = "time:read" | "time:write" | "time:manage";

async function scoped(ctx: Context, permission: Permission) {
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

// The issues of one request ask their totals together: a list of 50 issues is
// one chronix call, not 50. Keyed by the request's context.
interface Batch {
  ids: Set<string>;
  result: Promise<Map<string, TimeSpentView>>;
}
const batches = new WeakMap<object, Batch>();

function spent(ctx: Context, issueId: string): Promise<TimeSpentView> {
  let batch = batches.get(ctx);
  if (!batch) {
    const ids = new Set<string>();
    // Runs after the resolvers of the same tick have all enrolled.
    const result = Promise.resolve().then(
      async (): Promise<Map<string, TimeSpentView>> => {
        batches.delete(ctx);
        if (!(await can(ctx, "time:read"))) {
          return new Map([...ids].map((id) => [id, { status: "FORBIDDEN" }]));
        }
        return (await scoped(ctx, "time:read")).totals([...ids]);
      },
    );
    batch = { ids, result };
    batches.set(ctx, batch);
  }
  batch.ids.add(issueId);
  return batch.result.then(
    (views) => views.get(issueId) ?? { status: "UNAVAILABLE" },
  );
}

// The viewer's timer is one per request, whatever the issues asked about.
const timers = new WeakMap<object, Promise<LinkTimer | null>>();

function myTimer(ctx: Context): Promise<LinkTimer | null> {
  let timer = timers.get(ctx);
  if (!timer) {
    timer = (async () => {
      if (!(await can(ctx, "time:write"))) return null;
      return (await scoped(ctx, "time:write")).tracking.runningTimer();
    })().catch(() => null);
    timers.set(ctx, timer);
  }
  return timer;
}

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

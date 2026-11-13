import type { Resolvers } from "@/generated/graphql/resolvers";
import { can, requirePermission, requireViewer } from "../../core/access";
import type { Context } from "../../http/context";
import { TimeService, type TimeSpentView } from "./time.service";

type Permission = "time:read" | "time:write" | "time:manage";

async function scoped(ctx: Context, permission: Permission) {
  const { mongo, tenant } = await requirePermission(ctx, permission);
  return new TimeService(
    mongo,
    tenant._id.toHexString(),
    requireViewer(ctx).id,
  );
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

export const timeResolvers: Resolvers = {
  Query: {
    timeLink: async (_, __, ctx) => (await scoped(ctx, "time:read")).status(),
  },
  Mutation: {
    linkChronix: async (_, { key }, ctx) =>
      (await scoped(ctx, "time:manage")).link(key),
    unlinkChronix: async (_, __, ctx) =>
      (await scoped(ctx, "time:manage")).unlink(),
    startIssueTimer: async (_, { issueId }, ctx) =>
      (await scoped(ctx, "time:write")).startTimer(issueId),
    logIssueTime: async (_, { issueId, input }, ctx) =>
      (await scoped(ctx, "time:write")).logTime(issueId, input),
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
      };
    },
  },
};

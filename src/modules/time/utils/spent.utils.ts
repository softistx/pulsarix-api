import type { LinkTimer } from "@softistx/chronix-react/server";
import { can } from "../../../core/access";
import type { Context } from "../../../http/context";
import type { TimeSpentView } from "../services";
import { scoped } from "./scoped.utils";

// The issues of one request ask their totals together: a list of 50 issues is
// one chronix call, not 50. Keyed by the request's context.
interface Batch {
  ids: Set<string>;
  result: Promise<Map<string, TimeSpentView>>;
}
const batches = new WeakMap<object, Batch>();

export function spent(ctx: Context, issueId: string): Promise<TimeSpentView> {
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

export function myTimer(ctx: Context): Promise<LinkTimer | null> {
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

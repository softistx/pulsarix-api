import { can, requirePermission } from "../core/access";
import type { Context } from "../http/context";
import { intakeLoaders } from "./intake/intake.data-loader";
import { projectsLoaders } from "./projects/projects.data-loader";
import { timeLoaders } from "./time/time.data-loader";
import { scoped as timeScoped } from "./time/utils";

// THE per-request loaders of the modules (DataLoader): built on first use for
// a request's context, never shared between requests, so a loader's cache
// never serves one viewer's data to another. Each loader runs its read guard
// itself, once per batch.
function build(ctx: Context) {
  return {
    projects: projectsLoaders(
      async () => (await requirePermission(ctx, "project:read")).mongo,
    ),
    intake: intakeLoaders(
      async () => (await requirePermission(ctx, "issue:write")).mongo,
    ),
    time: timeLoaders({
      totals: async () =>
        (await can(ctx, "time:read"))
          ? (await timeScoped(ctx, "time:read")).totals
          : null,
      timer: async () => {
        if (!(await can(ctx, "time:write"))) return null;
        const { tracking } = await timeScoped(ctx, "time:write");
        return () => tracking.runningTimer();
      },
    }),
  };
}

export type DataLoaders = ReturnType<typeof build>;

const perRequest = new WeakMap<Context, DataLoaders>();

export function dataLoaders(ctx: Context): DataLoaders {
  let loaders = perRequest.get(ctx);
  if (!loaders) {
    loaders = build(ctx);
    perRequest.set(ctx, loaders);
  }
  return loaders;
}

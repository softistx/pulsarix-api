import type { AppTenancy } from "../../config/db";
import { realtime } from "../../config/redis";
import { SprintSnapshots } from "./services";
import type { SprintsMongo } from "./sprints.types";

// The daily snapshots over every active organisation. One organisation
// failing does not stop the others; the job fails afterwards, so the queue
// retries it. Safe to repeat.
export async function snapshotAll(
  tenancy: Pick<AppTenancy, "eachTenant">,
  now = new Date(),
  log: (message: string, error?: unknown) => void = console.warn,
): Promise<number> {
  const results = await tenancy.eachTenant(
    async (tenant, mongo) => {
      const snapshots = new SprintSnapshots(
        mongo as unknown as SprintsMongo,
        tenant.timeZone,
      );
      const active = await (
        mongo as unknown as SprintsMongo
      ).db.sprints.findMany({ filter: { state: "active" } });
      let made = 0;
      for (const sprint of active) {
        if (await snapshots.daily(sprint, now)) made += 1;
      }
      return made;
    },
    { onError: "collect" },
  );
  let made = 0;
  let failed = 0;
  for (const result of results) {
    if (result.ok) made += result.value;
    else {
      failed += 1;
      log("sprint snapshots failed for an organisation", result.error);
    }
  }
  if (failed > 0) {
    throw new Error(`sprint snapshots failed for ${failed} organisation(s)`);
  }
  return made;
}

// Starts the worker of the daily burndown snapshots (the server calls it once).
// Without Redis there is no queue and no job: only in development, since
// production requires REDIS_URL.
export function startSnapshotWorker(
  tenancy: Pick<AppTenancy, "eachTenant">,
  log = console.warn,
) {
  const queue = realtime.queues?.sprintSnapshots;
  if (!queue) {
    log("no REDIS_URL: the sprint burndown snapshots do not run");
    return null;
  }
  const worker = queue.work(async () => {
    await snapshotAll(tenancy);
  });
  worker.on("error", (error) => log("sprint snapshots worker", error));
  return worker;
}

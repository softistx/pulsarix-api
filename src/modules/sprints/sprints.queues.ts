import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// Every export of this file is a queue (src/config/queues.ts gathers them).

// The daily burndown snapshots (plan §28): every 15 minutes, each organisation
// whose midnight has passed gets one snapshot of the day that ended for each of
// its active sprints. A run takes only what is missing, so it is safe to repeat
// and a run that fails is retried. A day the job missed altogether is not made
// up: only yesterday is ever taken. Schedules fire only while a worker
// runs (src/server.ts starts it).
export const sprintSnapshots = defineQueue({
  name: "sprint-snapshots",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "1m", max: "15m" },
  timeout: "10m",
  keepCompleted: false,
  keepFailed: "7d",
  schedules: {
    frequent: { cron: "*/15 * * * *", timezone: "UTC", data: {} },
  },
});

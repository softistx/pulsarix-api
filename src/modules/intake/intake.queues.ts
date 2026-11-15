import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// Every export of this file is a queue (src/config/queues.ts gathers them).

// The retention job (plan Q15): every night, the e-mail of each report
// settled 90 days ago is erased in every organisation. A run that fails is
// retried; every run is safe to repeat (it erases what is due and nothing
// else). Schedules fire only while a worker runs (src/server.ts starts it).
export const intakeRetention = defineQueue({
  name: "intake-retention",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "5m", max: "1h" },
  timeout: "30m",
  keepCompleted: false,
  keepFailed: "7d",
  schedules: {
    nightly: { cron: "30 3 * * *", timezone: "UTC", data: {} },
  },
});

// The purge of report files (plan §17, A11): pending slots after 15 minutes,
// a declined report's files after 7 days, a never-triaged report's after 90.
// Every 5 minutes, so a slot goes soon after its ticket's deadline; each run
// removes what is due and nothing else, and is safe to repeat.
export const intakeFilesRetention = defineQueue({
  name: "intake-files-retention",
  schema: z.object({}),
  attempts: 3,
  backoff: { base: "1m", max: "15m" },
  timeout: "10m",
  keepCompleted: false,
  keepFailed: "7d",
  schedules: {
    frequent: { cron: "*/5 * * * *", timezone: "UTC", data: {} },
  },
});

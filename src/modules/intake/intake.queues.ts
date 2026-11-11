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

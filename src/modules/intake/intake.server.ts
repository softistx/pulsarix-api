import { type AppTenancy, coreMongo } from "../../config/db";
import { env } from "../../config/env";
import { mailer } from "../../config/mail";
import { realtime } from "../../config/redis";
import { eraseAll } from "./intake.retention";
import {
  type IntakeDeps,
  type IntakeLimits,
  PublicIntake,
} from "./intake.submit";

// The public intake as the server runs it: the core database, the given
// tenancy store, the Redis rate limits (none without Redis: the endpoint then
// refuses, 503), the server's mailer, and the live channel of the inbox.
// `overrides` is for specs: the limits and mailer a spec has no Redis or SMTP for.
export function serverIntake(
  tenancy: Pick<AppTenancy, "resolve" | "databaseOf">,
  overrides: Partial<Pick<IntakeDeps, "limits" | "mailer" | "log">> = {},
) {
  return new PublicIntake({
    core: coreMongo,
    tenancy,
    limits: realtime.limits as unknown as IntakeLimits | undefined,
    mailer,
    ...overrides,
    from: { name: "pulsarix", address: env.MAIL_FROM },
    uiOrigin: env.UI_ORIGIN,
    publish: async (event) => {
      await realtime.channels.clientReportReceived.publish(event);
    },
  });
}

// Starts the worker of the nightly retention job (the server calls it once).
// Without Redis there is no queue and no job: only in development, since
// production requires REDIS_URL.
export function startRetentionWorker(
  tenancy: Pick<AppTenancy, "eachTenant">,
  log = console.warn,
) {
  const queue = realtime.queues?.intakeRetention;
  if (!queue) {
    log("no REDIS_URL: the intake retention job does not run");
    return null;
  }
  const worker = queue.work(async () => {
    await eraseAll(tenancy);
  });
  worker.on("error", (error) => log("intake retention worker", error));
  return worker;
}

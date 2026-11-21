import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// Every export of this file is a queue (src/config/redis.ts wires them all).

// One job per member and time window, added after a notification commits and
// due DIGEST_DELAY later (services/digest.service.ts): it mails what the member
// has not read by then. A mail that fails is retried with a growing wait; a
// job that completes leaves nothing behind.
export const notificationDigest = defineQueue({
  name: "notification-digest",
  schema: z.object({ organisationId: z.string(), recipientId: z.string() }),
  attempts: 5,
  backoff: { base: "30s", max: "30m" },
  timeout: "1m",
  keepCompleted: false,
  keepFailed: "7d",
});

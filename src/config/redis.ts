import {
  defineRedis,
  type LimitScope,
  localChannels,
  openRedis,
  type QueueScope,
} from "@softistx/redis";
import { RedisClient } from "bun";
import * as channels from "../modules/activity/activity.channels";
import { env } from "./env";
import * as limits from "./limits";
import * as queues from "./queues";

// The live channels of the API (src/modules/activity/activity.channels.ts), its
// queues (src/modules/notifications/notifications.queues.ts) and what closes
// them. The limits are in src/config/limits.ts. Queues and rate limits need Redis: without it `queues` and `limits`
// are absent (the public endpoint then refuses, 503).
export interface Realtime {
  readonly channels: ReturnType<
    typeof localChannels<typeof channels>
  >["channels"];
  readonly queues?: QueueScope<typeof queues> | undefined;
  readonly limits?: LimitScope<typeof limits> | undefined;
  close(): Promise<void>;
}

// The app's Redis, at `uri`. It never waits for Redis: the client is handed to
// `openRedis` unconnected and @softistx/redis connects in the background,
// retrying until Redis answers (and after a drop), so the API starts while
// Redis is down; a publish meanwhile reaches the subscribers of this process
// only (`fallback: 'local'`). Without a `uri`, outside production, the channels
// run in this process alone (one instance, a spec).
export async function openRealtime(
  uri: string | undefined,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<Realtime> {
  if (uri === undefined) return localChannels({ channels });
  const client = new RedisClient(uri, {
    enableOfflineQueue: false,
    connectionTimeout: 1_000,
  });
  const redis = await openRedis(
    defineRedis({
      client,
      prefix: "pulsarix",
      channels,
      queues,
      limits,
      background: {
        onDown: () =>
          log("redis unavailable: live events stay in this process"),
        onUp: () => log("redis is back"),
      },
    }),
  );
  return {
    channels: redis.channels as Realtime["channels"],
    queues: redis.queues as unknown as Realtime["queues"],
    limits: redis.limits as unknown as Realtime["limits"],
    close: async () => {
      await redis.close();
      client.close();
    },
  };
}

// Opened once, when this module is first imported.
export const realtime: Realtime = await openRealtime(env.REDIS_URL);

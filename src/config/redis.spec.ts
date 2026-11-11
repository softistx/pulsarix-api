import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { openRealtime } from "./redis";

const event = (n: string) => ({
  organisationId: "o1",
  activityId: n,
  verb: "moved" as const,
  projectId: "p1",
  issueId: "i1",
  issueKey: "ABC-1",
  actorId: "a1",
  fields: ["statusId"],
  statusId: "s1",
  rank: "n",
  at: new Date(0).toISOString(),
});

const heard = async (stream: AsyncGenerator<{ activityId: string }>) =>
  (await Promise.race([stream.next(), Bun.sleep(3_000).then(() => null)]))
    ?.value?.activityId ?? null;

describe("the live channels", () => {
  test("without Redis they run in this process", async () => {
    const realtime = await openRealtime(undefined);
    const stream = realtime.channels.projectBoard.stream("o1:p1");
    await stream.ready();
    await realtime.channels.projectBoard.publish(event("one"));
    expect(await heard(stream)).toBe("one");
    await realtime.close();
  });

  test("an unreachable Redis does not stop the start, and this process still hears itself", async () => {
    const realtime = await openRealtime("redis://127.0.0.1:1", () => {});
    const stream = realtime.channels.projectBoard.stream("o1:p1");
    const next = stream.next();
    await realtime.channels.projectBoard.publish(event("local"));
    expect((await next).value?.activityId).toBe("local");
    await realtime.close();
  });
});

// A real Redis server, found in the package cache or $REDIS_BIN; the spec is
// skipped where there is none (building one takes minutes).
const binary =
  Bun.env["REDIS_BIN"] ??
  "node_modules/.cache/redis-memory-server/redis-binaries/stable/redis-server";
// CI provides the binary through $REDIS_BIN (ci.yml) where the runner can; without one the
// spec is skipped.
const real = existsSync(binary) ? test : test.skip;

describe("across API instances", () => {
  let redis: TestRedis | undefined;
  afterAll(async () => {
    await redis?.stop();
  });

  real(
    "an event published by one instance reaches the other's subscriber",
    async () => {
      redis = await startTestRedis({ binary });
      const publisher = await openRealtime(redis.uri, () => {});
      const subscriber = await openRealtime(redis.uri, () => {});
      const stream = subscriber.channels.projectBoard.stream("o1:p1");
      await stream.ready();
      const other = subscriber.channels.projectBoard.stream("o1:p2");
      await other.ready();
      await publisher.channels.projectBoard.publish(event("across"));
      expect(await heard(stream)).toBe("across");
      // Another project's key hears nothing.
      expect(await heard(other)).toBeNull();
      await publisher.close();
      await subscriber.close();
    },
    15_000,
  );

  real(
    "the digest queue is wired: one job per id, run by a worker, absent without Redis",
    async () => {
      expect((await openRealtime(undefined)).queues).toBeUndefined();
      redis = await startTestRedis({ binary });
      const realtime = await openRealtime(redis.uri, () => {});
      const queue = realtime.queues?.notificationDigest;
      if (!queue) throw new Error("no digest queue");
      const job = { organisationId: "o1", recipientId: "r1" };
      // The client connects in the background: add once it has.
      const add = async (): Promise<Awaited<ReturnType<typeof queue.add>>> => {
        for (let tries = 0; ; tries++) {
          try {
            return await queue.add(job, { id: "digest:o1:r1:1" });
          } catch (error) {
            if (tries >= 50) throw error;
            await Bun.sleep(100);
          }
        }
      };
      const first = await add();
      const again = await queue.add(job, { id: "digest:o1:r1:1" });
      expect([first.deduplicated, again.deduplicated]).toEqual([false, true]);
      const seen: unknown[] = [];
      const worker = queue.work(async ({ data }) => {
        seen.push(data);
      });
      await first.finished({ timeout: "5s" });
      expect(seen).toEqual([job]);
      await worker.close();
      await realtime.close();
    },
    15_000,
  );
});

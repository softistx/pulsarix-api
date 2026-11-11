import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createMemoryMailer } from "@softistx/mail";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { goodReport, intakeKit } from "~/intake";
import { coreMongo, tenancy } from "../../config/db";
import { openRealtime, type Realtime } from "../../config/redis";
import { type IntakeLimits, PublicIntake } from "./intake.submit";

// The real limits over a real Redis server, found in the package cache or
// $REDIS_BIN; skipped where there is none (building one takes minutes).
const binary =
  Bun.env["REDIS_BIN"] ??
  "node_modules/.cache/redis-memory-server/redis-binaries/stable/redis-server";
const real = existsSync(binary) ? test : test.skip;

describe("the limits over Redis", () => {
  let redis: TestRedis | undefined;
  let realtime: Realtime | undefined;
  afterAll(async () => {
    await realtime?.close();
    await redis?.stop();
  });

  real(
    "the sixth report of one address is a 429 with a wait in seconds",
    async () => {
      redis = await startTestRedis({ binary });
      realtime = await openRealtime(redis.uri, () => {});
      const limits = realtime.limits as unknown as IntakeLimits;
      expect(Object.keys(limits).sort()).toEqual([
        "intakeEmail",
        "intakeIpKey",
        "intakeKey",
        "intakeOrganisation",
        "intakeReadIp",
        "intakeTrackingIp",
      ]);
      const kit = await intakeKit();
      const intake = new PublicIntake({
        core: coreMongo,
        tenancy,
        limits,
        mailer: createMemoryMailer(),
        from: { name: "pulsarix", address: "noreply@pulsarix.test" },
        uiOrigin: "https://ui.pulsarix.test",
        publish: async () => {},
        log: () => {},
      });
      const caller = {
        ip: "203.0.113.9",
        origin: kit.site,
        userAgent: null,
        language: "en" as const,
        originGranted: false,
      };
      for (let i = 0; i < 5; i++) {
        await intake.submit(kit.key.publicKey, goodReport(), caller);
      }
      const refused = await intake
        .submit(kit.key.publicKey, goodReport(), caller)
        .catch((error) => error);
      expect(refused.extensions).toMatchObject({
        code: "intake.errors.too-many-requests",
        http: { status: 429 },
      });
      // 5 per 10 minutes: one every two minutes.
      expect(refused.extensions.retryAfter).toBeGreaterThan(60);
      expect(refused.extensions.retryAfter).toBeLessThanOrEqual(600);
      // Another address is not held back by it.
      await intake.submit(kit.key.publicKey, goodReport(), {
        ...caller,
        ip: "203.0.113.10",
      });
    },
    60_000,
  );
});

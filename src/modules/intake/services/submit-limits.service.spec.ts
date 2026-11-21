import { describe, expect, test } from "bun:test";
import {
  codeOfBody,
  countingLimits,
  goodReport,
  type IntakeKit,
  intakeKit,
} from "~/intake";
import { reportsOf } from "~/submit";
import { addressKey } from "../../../core/shared/address";
import type { Caller } from "./submit.service";

describe("over the limits the answer is 429", () => {
  const direct = (
    kit: IntakeKit,
    ip = "203.0.113.7",
    origin = kit.site,
  ): Caller => ({
    ip,
    origin,
    userAgent: null,
    language: "en",
    originGranted: false,
  });

  test("the sixth report of one address through one key", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 5; i++) {
      expect((await kit.submit()).response.status).toBe(200);
    }
    const { response, body } = await kit.submit();
    expect(response.status).toBe(429);
    expect(codeOfBody(body)).toBe("intake.errors.too-many-requests");
    expect(response.headers.get("retry-after")).toBe("90");
    expect(body?.errors?.[0]?.extensions).toMatchObject({
      retryAfter: 90,
      minutes: 2,
    });
    // The widget can read the refusal: the origin was accepted.
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    expect(await reportsOf(kit)).toHaveLength(5);
  });

  test("another address has its own five", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 6; i++) {
      await kit.intake
        .submit(kit.key.publicKey, goodReport(), direct(kit, "198.51.100.1"))
        .catch(() => {});
    }
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, "198.51.100.1"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "intake.errors.too-many-requests" },
    });
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, "198.51.100.2"),
      ),
    ).resolves.toMatchObject({ tracking: false });
  });

  test("the key's hourly limit holds across addresses", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 60; i++) {
      await kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, `10.0.${Math.floor(i / 5)}.${i % 5}`),
      );
    }
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport(),
        direct(kit, "10.9.9.9"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "intake.errors.too-many-requests" },
    });
  });

  test("the fourth report naming one e-mail", async () => {
    const kit = await intakeKit();
    for (let i = 0; i < 3; i++) {
      await kit.intake.submit(
        kit.key.publicKey,
        goodReport({ email: "Same@x.test" }),
        direct(kit, `10.1.0.${i}`),
      );
    }
    await expect(
      kit.intake.submit(
        kit.key.publicKey,
        goodReport({ email: "same@X.test" }),
        direct(kit, "10.1.0.9"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "intake.errors.too-many-requests" },
    });
    // No address is written to the limiter's keys.
    const keys = [
      ...(
        kit.limits as ReturnType<typeof countingLimits>
      ).intakeEmail.counts.keys(),
    ];
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  test("the organisation's ceiling holds across its keys", async () => {
    const kit = await intakeKit();
    const limits = kit.limits as ReturnType<typeof countingLimits>;
    limits.intakeOrganisation.counts.set(kit.organisation.id, 300);
    const { response, body } = await kit.submit();
    expect(response.status).toBe(429);
    expect(codeOfBody(body)).toBe("intake.errors.too-many-requests");
  });

  test("reads and preflights of one address are limited too", async () => {
    const kit = await intakeKit();
    const limits = kit.limits as ReturnType<typeof countingLimits>;
    limits.intakeReadIp.counts.set("unknown", 120);
    expect((await kit.config()).response.status).toBe(429);
  });

  test("the tracking page's reads are limited", async () => {
    const kit = await intakeKit();
    const limits = kit.limits as ReturnType<typeof countingLimits>;
    limits.intakeTrackingIp.counts.set("unknown", 30);
    const { response, body } = await kit.track(
      `${kit.organisation.id}.${"a".repeat(43)}`,
    );
    expect(response.status).toBe(429);
    expect(codeOfBody(body)).toBe("intake.errors.too-many-requests");
  });

  test("with no way to count, the endpoint refuses (503) instead of opening unmetered", async () => {
    const kit = await intakeKit({ limits: undefined });
    const { response, body } = await kit.config();
    expect(response.status).toBe(503);
    expect(codeOfBody(body)).toBe("intake.errors.unavailable");
    expect((await kit.submit()).response.status).toBe(503);
    expect(await reportsOf(kit)).toHaveLength(0);
  });

  test("a limiter that fails is a 503, never a pass", async () => {
    const limits = countingLimits();
    const kit = await intakeKit({
      limits: {
        ...limits,
        intakeReadIp: {
          consume: async () => {
            throw new Error("redis down");
          },
        },
      },
    });
    expect((await kit.config()).response.status).toBe(503);
  });
});

test("IPv6 clients are limited by their /64", () => {
  expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  expect(addressKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
  expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
  expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  expect(addressKey(undefined)).toBe("unknown");
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { ObjectId } from "mongodb";
import { codeOfBody } from "~/intake";
import { startMediaS3 } from "~/media";
import { worldWith } from "~/tracking";

let s3: TestS3;
let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const world = () => worldWith(media);

describe("e-mails and erasure", () => {
  test("the e-mail switch is for this request", async () => {
    const w = await world();
    const a = await w.report();
    const b = await w.report();
    const off = await w.ui("trackingEmails", a.token, { on: false });
    expect(off.body?.data?.["trackingEmails"]).toBe(false);
    expect((await w.status(a.token))["emailsOn"]).toBe(false);
    expect((await w.status(b.token))["emailsOn"]).toBe(true);
  });

  test("erase removes the data, the token is unknown after, and once an hour", async () => {
    const w = await world();
    const { token, id } = await w.report();
    await w.ui("trackingReply", token, { input: { body: "my private note" } });
    const erased = await w.ui("trackingErase", token);
    expect(erased.body?.data?.["trackingErase"]).toEqual({ requests: 1 });
    const stored = await w.mongo.db.clientReports.findById(new ObjectId(id));
    expect(stored).toMatchObject({
      email: null,
      trackingTokenHash: null,
    });
    expect(stored?.["erasedAt"]).toBeInstanceOf(Date);
    for (const op of [
      "clientReportStatus",
      "trackingResolve",
      "trackingErase",
    ]) {
      const answer = await w.ui(op, token);
      expect(answer.status).toBe(404);
      expect(codeOfBody(answer.body)).toBe("intake.errors.not-found");
    }
  });
});

describe("trackingErase when the erasure fails", () => {
  test("does not spend the hour: a retry erases", async () => {
    const w = await world();
    const { token, id } = await w.report();
    const real = w.kit.intake.databaseOf.bind(w.kit.intake);
    let armed = true;
    w.kit.intake.databaseOf = (async (key: Parameters<typeof real>[0]) => {
      const mongo = await real(key);
      return new Proxy(mongo, {
        get(target, property) {
          if (property === "as" && armed) {
            armed = false;
            return () => {
              throw new Error("database down");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof real;
    try {
      const failed = await w.ui("trackingErase", token);
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      w.kit.intake.databaseOf = real;
    }
    const retry = await w.ui("trackingErase", token);
    expect(retry.body?.data?.["trackingErase"]).toEqual({ requests: 1 });
    expect(
      (await w.mongo.db.clientReports.findById(new ObjectId(id)))?.["erasedAt"],
    ).toBeInstanceOf(Date);
  });
});

import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { pendingCountsOf } from "./files-team.service";
import type { IntakeMongo } from "./reports.service";

// `pendingCountsOf` over a fake collection whose `aggregate` is a spy.
function fake(rows: Array<{ _id: ObjectId; count: number }>, fail?: Error) {
  const calls: unknown[][] = [];
  const mongo = {
    db: {
      clientReportFiles: {
        raw: {
          aggregate: (pipeline: unknown[]) => {
            calls.push(pipeline);
            return {
              toArray: () =>
                fail ? Promise.reject(fail) : Promise.resolve(rows),
            };
          },
        },
      },
    },
  } as unknown as IntakeMongo;
  return { mongo, calls };
}

const matchOf = (pipeline: unknown[]) =>
  (pipeline[0] as { $match: Record<string, unknown> }).$match;

describe("pendingCountsOf", () => {
  test("N report ids are one aggregate, keyed by hex id", async () => {
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
    const { mongo, calls } = fake([{ _id: ids[1] as ObjectId, count: 2 }]);
    const counts = await pendingCountsOf(mongo, ids);
    expect(calls).toHaveLength(1);
    expect(counts.get((ids[1] as ObjectId).toHexString())).toBe(2);
    expect(counts.has((ids[0] as ObjectId).toHexString())).toBe(false);
  });

  test("no ids is no query", async () => {
    const { mongo, calls } = fake([]);
    expect((await pendingCountsOf(mongo, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a rejected aggregate rejects every caller sharing the promise", async () => {
    const { mongo, calls } = fake([], new Error("db down"));
    const shared = pendingCountsOf(mongo, [new ObjectId()]);
    const waiters = [
      shared.then((c) => c.get("x")),
      shared.then((c) => c.size),
    ];
    const settled = await Promise.allSettled(waiters);
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason.message).toBe("db down");
    }
    expect(calls).toHaveLength(1);
  });

  test("a pending slot with a null deadline counts, and an explicit now is honoured", async () => {
    const { mongo, calls } = fake([]);
    const now = new Date("2026-01-02T03:04:05Z");
    await pendingCountsOf(mongo, [new ObjectId()], now);
    const match = matchOf(calls[0] as unknown[]);
    expect(match["state"]).toBe("pending");
    expect(match["$or"]).toEqual([
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ]);
  });
});

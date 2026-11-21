import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IntakeMongo } from "../intake.types";
import { pendingLoader } from "./pending.data-loader";

function fake(counts: Map<string, number>) {
  const calls: Array<Array<{ $match: { reportId: { $in: ObjectId[] } } }>> = [];
  const mongo = {
    db: {
      clientReportFiles: {
        raw: {
          aggregate: (pipeline: (typeof calls)[number]) => {
            calls.push(pipeline);
            return {
              toArray: () =>
                Promise.resolve(
                  [...counts].map(([id, count]) => ({
                    _id: new ObjectId(id),
                    count,
                  })),
                ),
            };
          },
        },
      },
    },
  } as unknown as IntakeMongo;
  return { mongoOf: () => Promise.resolve(mongo), calls };
}

describe("pendingLoader", () => {
  test("the pending files of N reports are one grouped read", async () => {
    const [a, b, c] = [new ObjectId(), new ObjectId(), new ObjectId()];
    const { mongoOf, calls } = fake(
      new Map([
        [a.toHexString(), 2],
        [b.toHexString(), 1],
      ]),
    );
    const loader = pendingLoader(mongoOf);
    const counts = await Promise.all(
      [a, b, c].map((id) => loader.load(id.toHexString())),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.$match.reportId.$in).toHaveLength(3);
    expect(counts).toEqual([2, 1, 0]);
  });

  test("a report asked twice in a request is read once", async () => {
    const id = new ObjectId().toHexString();
    const { mongoOf, calls } = fake(new Map([[id, 3]]));
    const loader = pendingLoader(mongoOf);
    const counts = await Promise.all([loader.load(id), loader.load(id)]);
    expect(counts).toEqual([3, 3]);
    expect(calls).toHaveLength(1);
  });

  test("a rejected guard rejects every report of the batch", async () => {
    const loader = pendingLoader(() => Promise.reject(new Error("no")));
    const results = await Promise.allSettled([
      loader.load(new ObjectId().toHexString()),
      loader.load(new ObjectId().toHexString()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});

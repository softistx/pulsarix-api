import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IntakeMongo } from "../intake.types";
import { filesLoader } from "./files.data-loader";

function fake(rows: object[]) {
  const calls: Array<{ filter: Record<string, unknown> }> = [];
  const mongo = {
    db: {
      clientReportFiles: {
        findMany: (query: { filter: Record<string, unknown> }) => {
          calls.push(query);
          return Promise.resolve(rows);
        },
      },
    },
  } as unknown as IntakeMongo;
  return { mongoOf: () => Promise.resolve(mongo), calls };
}

describe("filesLoader", () => {
  test("the files of N reports are one read, grouped per report", async () => {
    const [a, b, c] = [new ObjectId(), new ObjectId(), new ObjectId()];
    const rows = [
      { reportId: a, name: "1" },
      { reportId: b, name: "2" },
      { reportId: a, name: "3" },
    ];
    const { mongoOf, calls } = fake(rows);
    const files = filesLoader(mongoOf);
    const [first, second, third] = await Promise.all(
      [a, b, c].map((id) => files.load(id.toHexString())),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filter).toMatchObject({
      state: { $in: ["quarantined", "released"] },
    });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(third).toEqual([]);
  });

  test("a rejected guard rejects every report of the batch", async () => {
    const files = filesLoader(() => Promise.reject(new Error("no")));
    const results = await Promise.allSettled([
      files.load(new ObjectId().toHexString()),
      files.load(new ObjectId().toHexString()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});

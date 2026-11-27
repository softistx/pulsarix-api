import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { sprintsLoaders } from "./sprints.data-loader";
import type { SprintsMongo } from "./sprints.types";

describe("sprintsLoaders", () => {
  test("the progress of N sprints is one aggregation and one guard", async () => {
    const [a, b, c] = [new ObjectId(), new ObjectId(), new ObjectId()];
    let aggregations = 0;
    let guards = 0;
    const mongo = {
      db: {
        issues: {
          raw: {
            aggregate: () => {
              aggregations += 1;
              return {
                toArray: () =>
                  Promise.resolve([
                    {
                      _id: a,
                      points: 8,
                      pointsDone: 5,
                      issues: 3,
                      issuesDone: 1,
                    },
                  ]),
              };
            },
          },
        },
      },
    } as unknown as SprintsMongo;
    const { progress } = sprintsLoaders(() => {
      guards += 1;
      return Promise.resolve(mongo);
    });
    const all = await Promise.all(
      [a, b, c].map((id) => progress.load(id.toHexString())),
    );
    expect(aggregations).toBe(1);
    expect(guards).toBe(1);
    expect(all[0]).toEqual({
      points: 8,
      pointsDone: 5,
      issues: 3,
      issuesDone: 1,
    });
    expect(all[1]).toEqual({
      points: 0,
      pointsDone: 0,
      issues: 0,
      issuesDone: 0,
    });
  });
});

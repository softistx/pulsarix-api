import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { timesOf } from "./times.utils";

describe("timesOf", () => {
  test("groups the creation dates by hex id", async () => {
    const id = new ObjectId();
    const times = [new Date(1), new Date(2)];
    const collection = {
      aggregate: () => ({ toArray: async () => [{ _id: id, times }] }),
    };
    const got = await timesOf(collection, {}, "$reportId");
    expect(got.get(id.toHexString())).toEqual(times);
    expect(got.size).toBe(1);
  });
});

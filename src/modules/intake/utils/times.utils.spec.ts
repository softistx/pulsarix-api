import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { timesByHexId } from "./times.utils";

describe("timesByHexId", () => {
  test("keys the dates by hex id", () => {
    const id = new ObjectId();
    const times = [new Date(1), new Date(2)];
    const got = timesByHexId([{ _id: id, times }]);
    expect(got.get(id.toHexString())).toEqual(times);
    expect(got.size).toBe(1);
  });
});

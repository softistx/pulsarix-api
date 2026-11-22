import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { issuesLoaders } from "./issues.data-loader";
import type { IssuesMongo } from "./issues.types";

// Fake collections whose `findMany` is a spy over fixed rows.
function fake(
  children: { parentId: ObjectId; statusId: ObjectId }[],
  statuses: { id: string; category: string }[],
) {
  const calls = { issues: 0, statuses: 0 };
  const mongo = {
    db: {
      issues: {
        findMany: () => {
          calls.issues += 1;
          return Promise.resolve(children);
        },
      },
      statuses: {
        findMany: () => {
          calls.statuses += 1;
          return Promise.resolve(statuses);
        },
      },
    },
  } as unknown as IssuesMongo;
  let guards = 0;
  const mongoOf = () => {
    guards += 1;
    return Promise.resolve(mongo);
  };
  return { mongoOf, calls, guards: () => guards };
}

describe("issuesLoaders", () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const open = new ObjectId();
  const finished = new ObjectId();
  const dropped = new ObjectId();
  const statuses = [
    { id: open.toHexString(), category: "active" },
    { id: finished.toHexString(), category: "done" },
    { id: dropped.toHexString(), category: "cancelled" },
  ];

  test("the progress of N issues is two reads and one guard", async () => {
    const children = [
      { parentId: a, statusId: finished },
      { parentId: a, statusId: open },
      { parentId: a, statusId: dropped },
    ];
    const { mongoOf, calls, guards } = fake(children, statuses);
    const { progress } = issuesLoaders(mongoOf);
    const [first, second] = await Promise.all([
      progress.load(a.toHexString()),
      progress.load(b.toHexString()),
    ]);
    expect(calls).toEqual({ issues: 1, statuses: 1 });
    expect(guards()).toBe(1);
    expect(first).toEqual({ done: 1, total: 2 });
    expect(second).toEqual({ done: 0, total: 0 });
  });

  test("a refused guard rejects every issue of the batch", async () => {
    const { progress } = issuesLoaders(() =>
      Promise.reject(new Error("forbidden")),
    );
    await expect(progress.load(a.toHexString())).rejects.toThrow("forbidden");
  });
});

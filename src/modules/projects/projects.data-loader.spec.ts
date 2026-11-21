import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { projectsLoaders } from "./projects.data-loader";
import type { ProjectsMongo } from "./projects.usage";

// Fake collections whose `findMany` is a spy over fixed rows.
function fake(statuses: object[], labels: object[]) {
  const calls: Record<string, unknown[]> = { statuses: [], labels: [] };
  const collection = (name: string, rows: object[]) => ({
    findMany: (query: unknown) => {
      calls[name]?.push(query);
      return Promise.resolve(rows);
    },
  });
  const mongo = {
    db: {
      statuses: collection("statuses", statuses),
      labels: collection("labels", labels),
    },
  } as unknown as ProjectsMongo;
  let guards = 0;
  const mongoOf = () => {
    guards += 1;
    return Promise.resolve(mongo);
  };
  return { mongoOf, calls, guards: () => guards };
}

describe("projectsLoaders", () => {
  const a = new ObjectId();
  const b = new ObjectId();
  const c = new ObjectId();

  test("the statuses of N projects are one read, grouped per project", async () => {
    const rows = [
      { projectId: a, name: "To do" },
      { projectId: b, name: "Open" },
      { projectId: a, name: "Done" },
    ];
    const { mongoOf, calls, guards } = fake(rows, []);
    const { statuses } = projectsLoaders(mongoOf);
    const [first, second, third] = await Promise.all([
      statuses.load(a.toHexString()),
      statuses.load(b.toHexString()),
      statuses.load(c.toHexString()),
    ]);
    expect(calls.statuses).toHaveLength(1);
    expect(guards()).toBe(1);
    expect(first?.map((s) => (s as { name: string }).name)).toEqual([
      "To do",
      "Done",
    ]);
    expect(second).toHaveLength(1);
    expect(third).toEqual([]);
    expect(calls.statuses[0]).toMatchObject({ sort: { order: 1 } });
  });

  test("the labels of N projects are one read, by name, case-insensitive", async () => {
    const { mongoOf, calls } = fake([], [{ projectId: a, name: "bug" }]);
    const { labels } = projectsLoaders(mongoOf);
    const [first, second] = await Promise.all([
      labels.load(a.toHexString()),
      labels.load(b.toHexString()),
    ]);
    expect(calls.labels).toHaveLength(1);
    expect(calls.labels[0]).toMatchObject({
      sort: { name: 1 },
      collation: { locale: "en", strength: 2 },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("a project asked twice is read once", async () => {
    const { mongoOf, calls } = fake([], []);
    const { statuses } = projectsLoaders(mongoOf);
    await Promise.all([
      statuses.load(a.toHexString()),
      statuses.load(a.toHexString()),
    ]);
    expect(calls.statuses).toHaveLength(1);
    expect(
      (calls.statuses[0] as { filter: { projectId: { $in: unknown[] } } })
        .filter.projectId.$in,
    ).toHaveLength(1);
  });

  test("a refused guard rejects every project of the batch", async () => {
    const { statuses } = projectsLoaders(() =>
      Promise.reject(new Error("forbidden")),
    );
    const results = await Promise.allSettled([
      statuses.load(a.toHexString()),
      statuses.load(b.toHexString()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});

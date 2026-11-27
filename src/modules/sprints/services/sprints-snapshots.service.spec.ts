import { describe, expect, test } from "bun:test";
import { withSprints } from "~/sprints";
import { tenancy } from "../../../config/db";
import { addDays, dayIn } from "../../../core/shared/days";
import { snapshotAll } from "../sprints.server";
import type { SprintsMongo } from "../sprints.types";
import { SprintSnapshots } from "./snapshots.service";

const DAY = 86_400_000;

// An active sprint that started three days ago, with its tenant's database.
async function started(slug: string) {
  const t = await withSprints(slug);
  const sprint = await t.sprint();
  const a = await t.make("A", { type: "task", points: 2 });
  await t.plan([a], sprint.id);
  await t.start(sprint.id, {
    startDate: new Date(Date.now() - 3 * DAY).toISOString(),
  });
  const mongo = (await tenancy.databaseOf(
    t.organisation.id,
  )) as unknown as SprintsMongo;
  return { mongo };
}

describe("the daily snapshot", () => {
  test("the daily job makes a missing day once however often it runs", async () => {
    const { mongo } = await started("BDJ");
    const only = {
      eachTenant: async <T>(
        work: (tenant: { timeZone: string }, mongo: never) => Promise<T>,
      ) => [
        {
          ok: true as const,
          value: await work({ timeZone: "UTC" }, mongo as never),
        },
      ],
    };
    const now = new Date();
    expect(await snapshotAll(only as never, now)).toBe(1);
    expect(await snapshotAll(only as never, now)).toBe(0);
    const yesterday = addDays(dayIn("UTC", now), -1);
    const daily = await mongo.db.sprintSnapshots.findMany({
      filter: { reason: "daily" },
    });
    expect(daily.map((s) => s.day)).toEqual([yesterday]);
  });

  test("two runs racing for the same day make one snapshot and swallow the conflict", async () => {
    const { mongo } = await started("BDR");
    const sprint = (
      await mongo.db.sprints.findMany({
        filter: { state: "active" },
      })
    )[0];
    if (!sprint) throw new Error("sprint");
    const snapshots = new SprintSnapshots(mongo, "UTC");
    const now = new Date();
    const made = await Promise.all([
      snapshots.daily(sprint, now),
      snapshots.daily(sprint, now),
    ]);
    expect(made.filter(Boolean)).toHaveLength(1);
    const daily = await mongo.db.sprintSnapshots.findMany({
      filter: { sprintId: sprint._id, reason: "daily" },
    });
    expect(daily).toHaveLength(1);
  });
});

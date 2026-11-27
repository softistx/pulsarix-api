import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { Move } from "~/issues";
import { SprintBurndown, Velocity, withSprints } from "~/sprints";
import { tenancy } from "../../../config/db";
import { addDays, dayIn } from "../../../core/shared/days";
import { snapshotAll } from "../sprints.server";
import type { SprintsMongo } from "../sprints.types";
import { SprintLifecycle } from "./lifecycle.service";
import { SprintReports } from "./reports.service";
import { SprintSnapshots } from "./snapshots.service";
import { SprintsProject } from "./sprints-project.service";

const DAY = 86_400_000;

describe("the burndown of a sprint", () => {
  test("a mid-sprint scope change shows in today's point and the earlier days keep the committed scope", async () => {
    const t = await withSprints("BDN");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "story", points: 5 });
    const b = await t.make("B", { type: "task", points: 3 });
    const c = await t.make("C", { type: "task", points: 5 });
    await t.plan([a, b], sprint.id);
    const started = Date.now() - 2 * DAY;
    await t.start(sprint.id, {
      startDate: new Date(started).toISOString(),
      endDate: new Date(started + 6 * DAY).toISOString(),
    });
    await t.plan([c], sprint.id);
    await t.asOwner.call(Move, { id: a.id, statusId: t.done });

    const burndown = await t.burndown(sprint.id);
    const today = dayIn("UTC", new Date());
    const first = dayIn("UTC", new Date(started));
    expect(burndown.committedPoints).toBe(8);
    expect(burndown.timeZone).toBe("UTC");
    expect(burndown.points.map((p) => p.day)).toEqual(
      Array.from({ length: 7 }, (_, i) => addDays(first, i)),
    );
    // The ideal line falls from the committed scope to nothing on the last day.
    expect(burndown.points[0]?.ideal).toBe(8);
    expect(burndown.points[6]?.ideal).toBe(0);
    // The days before today carry the start's snapshot: 8 points, none done.
    const before = burndown.points.filter((p) => p.day < today);
    expect(before.length).toBeGreaterThan(0);
    for (const point of before) {
      expect(point.scopePoints).toBe(8);
      expect(point.remainingPoints).toBe(8);
    }
    // Today is read live: C joined (13 in scope) and A is done (5 of them).
    const now = burndown.points.find((p) => p.day === today);
    expect(now).toMatchObject({
      scopePoints: 13,
      completedPoints: 5,
      remainingPoints: 8,
    });
    // The days to come have no figures.
    for (const point of burndown.points.filter((p) => p.day > today)) {
      expect(point.remainingPoints).toBeNull();
    }
  });

  test("a planned sprint has no burndown, a closed one stops at its close", async () => {
    const t = await withSprints("BDC");
    const sprint = await t.sprint();
    expect((await t.burndown(sprint.id)).points).toEqual([]);
    const a = await t.make("A", { type: "task", points: 2 });
    await t.plan([a], sprint.id);
    const started = Date.now() - DAY;
    await t.start(sprint.id, {
      startDate: new Date(started).toISOString(),
      endDate: new Date(started + 5 * DAY).toISOString(),
    });
    await t.asOwner.call(Move, { id: a.id, statusId: t.done });
    await t.close(sprint.id, { unfinished: "BACKLOG" });
    const burndown = await t.burndown(sprint.id);
    const closedDay = dayIn("UTC", new Date());
    const last = burndown.points.find((p) => p.day === closedDay);
    // The close snapshot saw A done before the sprint was closed.
    expect(last).toMatchObject({ scopePoints: 2, completedPoints: 2 });
    expect(last?.remainingPoints).toBe(0);
    for (const point of burndown.points.filter((p) => p.day > closedDay)) {
      expect(point.remainingPoints).toBeNull();
    }
  });

  test("a sprint that does not exist is a 404", async () => {
    const t = await withSprints("BD4");
    const refused = await t.asOwner.attempt(SprintBurndown, {
      id: "64b7f0f0f0f0f0f0f0f0f0f0",
    });
    expect(codeOf(refused)).toBe("sprints.errors.not-found");
  });

  test("east of UTC the days, the daily snapshot and today follow the organisation's clock", async () => {
    const zone = "Pacific/Kiritimati";
    const t = await withSprints("BDZ");
    const mongo = (await tenancy.databaseOf(
      t.organisation.id,
    )) as unknown as SprintsMongo;
    const project = new SprintsProject(
      mongo,
      t.owner.id,
      t.organisation.id,
      zone,
    );
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "story", points: 5 });
    const b = await t.make("B", { type: "task", points: 3 });
    await t.plan([a, b], sprint.id);
    // 2026-11-20 00:00Z is already the 20th, 14:00, at Kiritimati (UTC+14).
    await new SprintLifecycle(project).start(sprint.id, {
      startDate: new Date("2026-11-20T00:00:00Z"),
      endDate: new Date("2026-12-04T00:00:00Z"),
    });
    await t.asOwner.call(Move, { id: a.id, statusId: t.done });

    // 10:30Z on 11-30 is 00:30 on 12-01 there: the 30th just ended.
    const now = new Date("2026-11-30T10:30:00Z");
    const stored = await mongo.db.sprints.findById(
      (await t.all(["active"]))[0]?.id as never,
    );
    if (!stored) throw new Error("sprint");
    const snapshots = new SprintSnapshots(mongo, zone);
    expect(await snapshots.daily(stored, now)).toBe(true);
    // The job runs every 15 minutes: the day is made once.
    expect(
      await snapshots.daily(stored, new Date(now.getTime() + 900_000)),
    ).toBe(false);
    const daily = await mongo.db.sprintSnapshots.findMany({
      filter: { sprintId: stored._id, reason: "daily" },
    });
    expect(daily.map((s) => s.day)).toEqual(["2026-11-30"]);
    expect(daily[0]?.takenAt.toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(daily[0]).toMatchObject({ scopePoints: 8, completedPoints: 5 });

    // B is done after the snapshot: the 30th keeps 3 to do, today shows 0.
    await t.asOwner.call(Move, { id: b.id, statusId: t.done });
    const burndown = await new SprintReports(project).burndown(
      stored._id.toHexString(),
      now,
    );
    const days = burndown.points.map((p) => p.day);
    expect(days[0]).toBe("2026-11-20");
    expect(days.at(-1)).toBe("2026-12-04");
    expect(days).toHaveLength(15);
    const at = (day: string) => burndown.points.find((p) => p.day === day);
    expect(at("2026-11-30")?.remainingPoints).toBe(3);
    expect(at("2026-12-01")?.remainingPoints).toBe(0);
    expect(at("2026-12-02")?.remainingPoints).toBeNull();
    expect(at("2026-12-04")?.ideal).toBe(0);
    // In UTC the same instant is still the 30th: the 1st has not come.
    const utc = await new SprintReports(
      new SprintsProject(mongo, t.owner.id, t.organisation.id, "UTC"),
    ).burndown(stored._id.toHexString(), now);
    expect(
      utc.points.find((p) => p.day === "2026-12-01")?.remainingPoints,
    ).toBeNull();
  });

  test("the daily job makes a missing day once however often it runs", async () => {
    const t = await withSprints("BDJ");
    const sprint = await t.sprint();
    const a = await t.make("A", { type: "task", points: 2 });
    await t.plan([a], sprint.id);
    await t.start(sprint.id, {
      startDate: new Date(Date.now() - 3 * DAY).toISOString(),
    });
    const mongo = (await tenancy.databaseOf(
      t.organisation.id,
    )) as unknown as SprintsMongo;
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
});

describe("the velocity of a project", () => {
  test("is the last closed sprints, oldest first, with their mean", async () => {
    const t = await withSprints("VEL");
    expect(await t.velocity()).toEqual({ average: 0, sprints: [] });
    const run = async (done: number, left: number) => {
      const sprint = await t.sprint();
      const issues = [
        await t.make(`Done ${sprint.number}`, { type: "task", points: done }),
        ...(left > 0
          ? [
              await t.make(`Left ${sprint.number}`, {
                type: "task",
                points: left,
              }),
            ]
          : []),
      ];
      await t.plan(issues, sprint.id);
      await t.start(sprint.id);
      await t.asOwner.call(Move, { id: issues[0]?.id, statusId: t.done });
      await t.close(sprint.id, { unfinished: "BACKLOG" });
      return sprint;
    };
    const one = await run(5, 0);
    const two = await run(3, 2);
    const three = await run(8, 0);
    // An active sprint is not history yet.
    const open = await t.sprint();
    await t.start(open.id);

    const all = await t.velocity();
    expect(all.sprints.map((s) => s.sprintId)).toEqual([
      one.id,
      two.id,
      three.id,
    ]);
    expect(all.sprints.map((s) => s.committedPoints)).toEqual([5, 5, 8]);
    expect(all.sprints.map((s) => s.completedPoints)).toEqual([5, 3, 8]);
    expect(all.average).toBe(5.3);
    expect(all.sprints[0]?.closedAt).not.toBeNull();

    const last = await t.velocity(2);
    expect(last.sprints.map((s) => s.sprintId)).toEqual([two.id, three.id]);
    expect(last.average).toBe(5.5);
  });

  test("refuses a project that does not exist and a count out of range", async () => {
    const t = await withSprints("VE4");
    const missing = await t.asOwner.attempt(Velocity, {
      projectId: "64b7f0f0f0f0f0f0f0f0f0f0",
    });
    expect(codeOf(missing)).toBe("projects.errors.not-found");
    const range = await t.asOwner.attempt(Velocity, {
      projectId: t.project.id,
      last: 0,
    });
    expect(range).toBeDefined();
  });
});

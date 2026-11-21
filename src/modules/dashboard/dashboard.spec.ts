import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { signedUp } from "~/auth";
import {
  DAY,
  Dashboard,
  type DashboardData,
  setup,
  workspace,
} from "~/dashboard";
import { codeOf } from "~/http";
import { intakeKit } from "~/intake";
import { figuresPipeline } from "./dashboard.utils";

const figuresOf = (data: DashboardData, key: string) =>
  data.dashboard.projects.find((p) => p.project.key === key);

describe("dashboard figures", () => {
  test("count exactly past 100, per project, leaving out closed and undated", async () => {
    const t = await setup();
    const day = t.startOfToday.getTime();
    const a = await t.project("AAA");
    const b = await t.project("BBB");
    await t.project("CCC");
    await a.issues("todo", 30, () => ({ priorityLevel: 4 }));
    await a.issues("inProgress", 20, () => ({ dueDate: new Date(day - 1) }));
    await a.issues("backlog", 95, (n) => ({
      priorityLevel: 2,
      dueDate: n % 2 ? new Date(day + DAY) : null,
    }));
    await a.issues("backlog", 5, () => ({ dueDate: new Date(day) }));
    await a.issues("done", 7, () => ({ dueDate: new Date(day - DAY) }));
    await a.issues("cancelled", 3, () => ({ priorityLevel: 4 }));
    await b.issues("todo", 4, (n) => ({ priorityLevel: n === 0 ? 4 : 1 }));

    const { dashboard } = await t.asOwner.call<DashboardData>(Dashboard);
    expect(dashboard.projects.map((p) => p.project.key)).toEqual([
      "AAA",
      "BBB",
      "CCC",
    ]);
    const [fa, fb, fc] = dashboard.projects;
    expect([fa?.open, fa?.urgent, fa?.late]).toEqual([150, 30, 20]);
    expect([fb?.open, fb?.urgent, fb?.late]).toEqual([4, 1, 0]);
    expect([fc?.open, fc?.urgent, fc?.late]).toEqual([0, 0, 0]);
  });

  test("an archived project is left out everywhere", async () => {
    const t = await setup();
    const a = await t.project("AAA");
    const b = await t.project("BBB");
    await a.issues("todo", 2);
    await b.issues("todo", 3, () => ({
      assigneeId: t.owner.id,
    }));
    await t.asOwner.call(
      `mutation($id: ID!) { archiveProject(id: $id) { id } }`,
      {
        id: b.id,
      },
    );
    const { dashboard } = await t.asOwner.call<DashboardData>(Dashboard);
    expect(dashboard.projects.map((p) => p.project.key)).toEqual(["AAA"]);
    expect(dashboard.assigned.totalCount).toBe(0);
  });

  test("late follows the organisation's time zone, not UTC", async () => {
    const t = await setup("Pacific/Kiritimati");
    const p = await t.project("AAA");
    const midnight = t.startOfToday.getTime();
    await p.issues("todo", 1, () => ({
      dueDate: new Date(midnight - 3_600_000),
    }));
    await p.issues("todo", 1, () => ({
      dueDate: new Date(midnight + 3_600_000),
    }));
    const { dashboard } = await t.asOwner.call<DashboardData>(Dashboard);
    expect(dashboard.timeZone).toBe("Pacific/Kiritimati");
    expect(dashboard.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(figuresOf({ dashboard } as DashboardData, "AAA")?.late).toBe(1);
  });

  test("the figures are read from the index alone (no FETCH)", async () => {
    const t = await setup();
    const p = await t.project("AAA");
    await p.issues("todo", 3);
    const pipeline = figuresPipeline(
      [new ObjectId(p.id)],
      [new ObjectId(p.status("todo"))],
      [new ObjectId(p.status("triage"))],
      t.startOfToday,
    );
    const explained = (await t.mongo.db.issues.raw
      .aggregate(pipeline)
      .explain("queryPlanner")) as {
      queryPlanner: { winningPlan: unknown };
    };
    // Rejected plans may fetch; the one that runs must not.
    const plan = JSON.stringify(explained.queryPlanner.winningPlan);
    expect(plan).toContain("IXSCAN");
    expect(plan).not.toContain('"stage":"FETCH"');
  });
});

describe("dashboard triage", () => {
  test("counts the triage issues and every new report, past 100", async () => {
    const k = await intakeKit();
    await k.submit();
    const t = await workspace(k.kit, k.owner, k.organisation);
    const other = await t.project("XYZ");
    await t.reports(k.project.id, 119);
    await other.issues("triage", 3);
    await other.issues("todo", 2);
    const { dashboard } = await k.asOwner.call<DashboardData>(Dashboard);
    const rows = new Map(dashboard.triage?.map((r) => [r.project.key, r]));
    expect(rows.get("ABC")).toMatchObject({ issues: 0, newReports: 120 });
    expect(rows.get("XYZ")).toMatchObject({ issues: 3, newReports: 0 });
  });

  test("is null without issue:write, the other sections still answer", async () => {
    const t = await setup();
    const p = await t.project("AAA");
    await p.issues("todo", 2);
    const viewer = await t.member("viewer");
    const { dashboard } = await t
      .as(viewer.token)
      .call<DashboardData>(Dashboard);
    expect(dashboard.triage).toBeNull();
    expect(figuresOf({ dashboard } as DashboardData, "AAA")?.open).toBe(2);
    expect(dashboard.assigned.totalCount).toBe(0);
  });
});

describe("dashboard access", () => {
  test("refuses anonymous callers and non-members", async () => {
    const t = await setup();
    expect(
      codeOf(
        await t.kit
          .client(null, { organisation: t.organisation.id })
          .attempt(Dashboard),
      ),
    ).toBe("auth.errors.unauthenticated");
    const outsider = await signedUp(t.kit);
    expect(
      codeOf(
        await t.kit
          .client(outsider.token, { organisation: t.organisation.id })
          .attempt(Dashboard),
      ),
    ).toBe("tenancy.errors.unknown-organization");
  });
});

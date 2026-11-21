import { beforeAll, describe, expect, test } from "bun:test";
import {
  calls,
  factory,
  fake,
  Issue,
  KEY,
  List,
  Log,
  mapProject,
  resetCalls,
  setup,
  type TimeSpent,
} from "~/time-tracking";
import { useChronix } from "../chronix.client";

beforeAll(() => useChronix(factory));

describe("the time spent", () => {
  test("is UNLINKED without a link, with no numbers", async () => {
    const { asOwner, make } = await setup(false);
    const issue = await make("No link");
    const read = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent).toEqual({
      status: "UNLINKED",
      totalSeconds: null,
      mySeconds: null,
      entryCount: null,
      running: null,
    });
  });

  test("reads the totals from chronix, with the viewer's own share", async () => {
    const { asOwner, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Tracked");
    await asOwner.call(Log, {
      issueId: issue.id,
      input: { date: "2026-11-13", durationSeconds: 3600 },
    });
    await asMember.call(Log, {
      issueId: issue.id,
      input: { date: "2026-11-13", durationSeconds: 1800 },
    });
    const mine = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(mine.issue.timeSpent).toEqual({
      status: "AVAILABLE",
      totalSeconds: 5400,
      mySeconds: 1800,
      entryCount: 2,
      running: false,
    });
  });

  test("a list of issues asks chronix once", async () => {
    const { asOwner, project, make } = await setup();
    await make("One");
    await make("Two");
    await make("Three");
    resetCalls();
    const list = await asOwner.call<{
      issues: { nodes: { timeSpent: { status: string } }[] };
    }>(List, { projectId: project.id });
    expect(list.issues.nodes.map((n) => n.timeSpent.status)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "AVAILABLE",
    ]);
    expect(calls().filter((c) => c.op === "totals")).toHaveLength(1);
  });

  test("a chronix outage leaves the issue page working: time unavailable, no error", async () => {
    const { asOwner, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("During an outage", { estimateHours: 3 });
    fake.goDown();
    const read = await asOwner.attempt<{
      issue: {
        key: string;
        title: string;
        estimateHours: number;
        timeSpent: TimeSpent;
      };
    }>(Issue, { key: issue.key });
    expect(read.errors).toBeUndefined();
    expect(read.data?.issue).toMatchObject({
      key: issue.key,
      title: "During an outage",
      estimateHours: 3,
      timeSpent: {
        status: "UNAVAILABLE",
        totalSeconds: null,
        mySeconds: null,
        entryCount: null,
        running: null,
      },
    });
    const list = await asOwner.attempt<{
      issues: { nodes: { key: string; timeSpent: { status: string } }[] };
    }>(List, { projectId: project.id });
    expect(list.errors).toBeUndefined();
    expect(list.data?.issues.nodes[0]?.timeSpent.status).toBe("UNAVAILABLE");
    // And it comes back by itself.
    fake.comeUp();
    const again = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(again.issue.timeSpent.status).toBe("AVAILABLE");
  });

  test("a revoked key degrades to UNAVAILABLE as well", async () => {
    const { asOwner, make } = await setup();
    const issue = await make("Revoked");
    fake.revokeKey(KEY);
    const read = await asOwner.attempt<{
      issue: { timeSpent: TimeSpent };
    }>(Issue, { key: issue.key });
    expect(read.errors).toBeUndefined();
    expect(read.data?.issue.timeSpent.status).toBe("UNAVAILABLE");
    fake.restoreKey(KEY);
  });
});

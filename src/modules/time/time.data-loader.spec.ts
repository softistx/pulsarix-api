import { describe, expect, test } from "bun:test";
import type { LinkTimer } from "@softistx/chronix-react/server";
import type { TimeSpentView } from "./services";
import { type TimeReads, timeLoaders } from "./time.data-loader";

const available: TimeSpentView = {
  status: "AVAILABLE",
  totalSeconds: 60,
  mySeconds: 30,
  entryCount: 2,
  running: false,
};

function reads(over: Partial<TimeReads> = {}) {
  const asked: string[][] = [];
  let timers = 0;
  const base: TimeReads = {
    totals: () =>
      Promise.resolve((ids) => {
        asked.push([...ids]);
        return Promise.resolve(new Map([[ids[0] as string, available]]));
      }),
    timer: () =>
      Promise.resolve(() => {
        timers += 1;
        return Promise.resolve({ issueId: "x" } as unknown as LinkTimer);
      }),
  };
  return { reads: { ...base, ...over }, asked, timers: () => timers };
}

describe("timeLoaders.spent", () => {
  test("the totals of N issues are one chronix call", async () => {
    const { reads: r, asked } = reads();
    const { spent } = timeLoaders(r);
    const views = await Promise.all(
      ["a", "b", "c"].map((id) => spent.load(id)),
    );
    expect(asked).toEqual([["a", "b", "c"]]);
    expect(views[0]).toEqual(available);
    expect(views[1]).toEqual({ status: "UNAVAILABLE" });
  });

  test("an issue asked twice in a tick is sent once, and read again later", async () => {
    const { reads: r, asked } = reads();
    const { spent } = timeLoaders(r);
    await Promise.all([spent.load("a"), spent.load("a")]);
    await spent.load("a");
    expect(asked).toEqual([["a"], ["a"]]);
  });

  test("a viewer without time:read gets FORBIDDEN and no call", async () => {
    const { reads: r, asked } = reads({ totals: () => Promise.resolve(null) });
    const view = await timeLoaders(r).spent.load("a");
    expect(view).toEqual({ status: "FORBIDDEN" });
    expect(asked).toHaveLength(0);
  });

  test("a failing call rejects the issues, which the resolver degrades", async () => {
    const { reads: r } = reads({
      totals: () => Promise.resolve(() => Promise.reject(new Error("down"))),
    });
    const { spent } = timeLoaders(r);
    const results = await Promise.allSettled([
      spent.load("a"),
      spent.load("b"),
    ]);
    expect(results.map((x) => x.status)).toEqual(["rejected", "rejected"]);
  });
});

describe("timeLoaders.timer", () => {
  test("the viewer's timer is read once, whatever asked", async () => {
    const { reads: r, timers } = reads();
    const { timer } = timeLoaders(r);
    await Promise.all([timer.load("me"), timer.load("me")]);
    await timer.load("me");
    expect(timers()).toBe(1);
  });

  test("no time:write, or a failing read, is no timer", async () => {
    const none = reads({ timer: () => Promise.resolve(null) });
    expect(await timeLoaders(none.reads).timer.load("me")).toBeNull();
    const failing = reads({ timer: () => Promise.reject(new Error("x")) });
    expect(await timeLoaders(failing.reads).timer.load("me")).toBeNull();
  });
});

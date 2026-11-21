import { beforeAll, describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import {
  calls,
  factory,
  fake,
  KEY,
  Mine,
  mapProject,
  resetCalls,
  Start,
  Stop,
  setup,
  tick,
} from "~/time-tracking";
import { useChronix } from "../chronix.client";

beforeAll(() => useChronix(factory));

describe("stopping the timer and reading the viewer's own", () => {
  test("stopIssueTimer saves the entry as the acting member, then answers null when none runs", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Stop me");
    await asMember.call(Start, { issueId: issue.id });
    resetCalls();
    tick(300);
    const stopped = await asMember.call<{
      stopIssueTimer: { durationSeconds: number } | null;
    }>(Stop, { issueId: issue.id });
    expect(stopped.stopIssueTimer?.durationSeconds).toBe(300);
    expect(calls().find((c) => c.op === "stopTimer")).toMatchObject({
      key: KEY,
      actor: member.email,
    });
    const again = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(again.stopIssueTimer).toBeNull();
  });

  test("a viewer cannot stop, and nothing is called", async () => {
    const { asViewer, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Viewer stop");
    resetCalls();
    const result = await asViewer.attempt(Stop, { issueId: issue.id });
    expect(codeOf(result)).toBe("auth.errors.forbidden");
    expect(calls()).toEqual([]);
  });

  test("stopping with no link, an unverified e-mail or an unknown issue is refused", async () => {
    const unlinked = await setup(false);
    const a = await unlinked.make("No link");
    expect(
      codeOf(await unlinked.asMember.attempt(Stop, { issueId: a.id })),
    ).toBe("time.errors.not-linked");
    const unverified = await setup(true, false);
    const b = await unverified.make("Unverified stop");
    expect(
      codeOf(await unverified.asOwner.attempt(Stop, { issueId: b.id })),
    ).toBe("time.errors.email-unverified");
    expect(
      codeOf(
        await unverified.asMember.attempt(Stop, {
          issueId: "000000000000000000000000",
        }),
      ),
    ).toBe("issues.errors.not-found");
  });

  test("chronix failures on stop go through chronixFailure", async () => {
    const { member, asMember, project, make } = await setup(true, true, {
      everyoneIsMember: false,
    });
    mapProject(project.id);
    const issue = await make("Failing stop");
    expect(codeOf(await asMember.attempt(Stop, { issueId: issue.id }))).toBe(
      "time.errors.forbidden",
    );
    fake.addMember(member.email);
    fake.goDown();
    expect(codeOf(await asMember.attempt(Stop, { issueId: issue.id }))).toBe(
      "time.errors.unavailable",
    );
    fake.comeUp();
    fake.revokeKey(KEY);
    expect(codeOf(await asMember.attempt(Stop, { issueId: issue.id }))).toBe(
      "time.errors.invalid-key",
    );
    fake.restoreKey(KEY);
  });

  test("stop leaves a timer that runs on another issue alone", async () => {
    const { asMember, project, make } = await setup();
    mapProject(project.id);
    const a = await make("Stale tab");
    const b = await make("Running");
    await asMember.call(Start, { issueId: b.id });
    resetCalls();
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: a.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
    expect(calls().some((c) => c.op === "stopTimer")).toBe(false);
    const still = await asMember.call<{
      issue: { timeSpent: { myRunningTimer: unknown } };
    }>(Mine, { key: b.key });
    expect(still.issue.timeSpent.myRunningTimer).not.toBeNull();
  });

  test("stop leaves a timer that has no reference alone", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Untracked");
    fake.startUntrackedTimer(member.email, project.id);
    resetCalls();
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
    expect(calls().some((c) => c.op === "stopTimer")).toBe(false);
  });

  test("a timer that vanishes between the two chronix calls stops as null", async () => {
    const { asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Race");
    await asMember.call(Start, { issueId: issue.id });
    fake.vanishAfterNextRead();
    resetCalls();
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
    expect(calls().map((c) => c.op)).toEqual(["runningTimer", "stopTimer"]);
  });

  test("an unmapped project is refused on start; stop has no project to map", async () => {
    const { asMember, make } = await setup();
    const issue = await make("Unmapped");
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.project-not-mapped",
    );
    const stopped = await asMember.call<{ stopIssueTimer: unknown }>(Stop, {
      issueId: issue.id,
    });
    expect(stopped.stopIssueTimer).toBeNull();
  });

  test("myRunningTimer shows the timer on its issue only, and null after the stop", async () => {
    const { asMember, asOwner, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Mine");
    const other = await make("Not mine");
    type Mine = {
      issue: {
        timeSpent: {
          status: string;
          myRunningTimer: { startedAt: string } | null;
        };
      };
    };
    expect(
      (await asMember.call<Mine>(Mine, { key: issue.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
    await asMember.call(Start, { issueId: issue.id });
    const on = await asMember.call<Mine>(Mine, { key: issue.key });
    expect(on.issue.timeSpent.myRunningTimer?.startedAt).toBe(
      "2026-11-13T10:00:00.000Z",
    );
    expect(
      (await asMember.call<Mine>(Mine, { key: other.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
    // Someone else's timer is not the viewer's.
    expect(
      (await asOwner.call<Mine>(Mine, { key: issue.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
    await asMember.call(Stop, { issueId: issue.id });
    expect(
      (await asMember.call<Mine>(Mine, { key: issue.key })).issue.timeSpent
        .myRunningTimer,
    ).toBeNull();
  });

  test("myRunningTimer is null for a viewer (no call), without a link, and when chronix is down", async () => {
    const { asMember, asViewer, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Quiet");
    await asMember.call(Start, { issueId: issue.id });
    resetCalls();
    const seen = await asViewer.call<{
      issue: { timeSpent: { myRunningTimer: unknown } };
    }>(Mine, { key: issue.key });
    expect(seen.issue.timeSpent.myRunningTimer).toBeNull();
    expect(calls().some((c) => c.op === "runningTimer")).toBe(false);
    fake.goDown();
    const down = await asMember.call<{
      issue: { timeSpent: { status: string; myRunningTimer: unknown } };
    }>(Mine, { key: issue.key });
    expect(down.issue.timeSpent.myRunningTimer).toBeNull();
    fake.comeUp();
    const unlinked = await setup(false);
    const x = await unlinked.make("Unlinked");
    const none = await unlinked.asMember.call<{
      issue: { timeSpent: { myRunningTimer: unknown } };
    }>(Mine, { key: x.key });
    expect(none.issue.timeSpent.myRunningTimer).toBeNull();
  });

  test("myRunningTimer is null for an unverified e-mail, with no chronix call", async () => {
    const { asOwner, make } = await setup(true, false);
    const issue = await make("Unverified");
    resetCalls();
    const seen = await asOwner.call<{
      issue: { timeSpent: { status: string; myRunningTimer: unknown } };
    }>(Mine, { key: issue.key });
    expect(seen.issue.timeSpent.myRunningTimer).toBeNull();
    expect(calls()).toEqual([]);
  });
});

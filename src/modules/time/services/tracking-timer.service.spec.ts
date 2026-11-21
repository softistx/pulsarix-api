import { beforeAll, describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import {
  ArchiveProject,
  calls,
  factory,
  fake,
  Issue,
  KEY,
  Log,
  mapProject,
  resetCalls,
  Start,
  Stop,
  setup,
  type TimeSpent,
  tick,
  Unlink,
} from "~/time-tracking";
import { useChronix } from "../chronix.client";

beforeAll(() => useChronix(factory));

describe("the timer and the manual log", () => {
  test("startIssueTimer passes the member's verified e-mail and the issue as reference", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Fix the login");
    resetCalls();
    const started = await asMember.call<{
      startIssueTimer: { startedAt: string; stoppedSeconds: number | null };
    }>(Start, { issueId: issue.id });
    expect(started.startIssueTimer.stoppedSeconds).toBeNull();
    const call = calls().find((c) => c.op === "startTimer");
    expect(call).toMatchObject({
      key: KEY,
      actor: member.email,
      input: {
        partnerProjectId: project.id,
        externalRef: {
          kind: "issue",
          id: issue.id,
          label: `${issue.key} Fix the login`,
        },
      },
    });
    const input = call?.input as { externalRef: { url: string } } | undefined;
    expect(input?.externalRef.url).toContain(`/issues/${issue.key}`);
    // A second timer stops the first: its seconds are told.
    const second = await make("Another");
    tick(600);
    const next = await asMember.call<{
      startIssueTimer: { stoppedSeconds: number | null };
    }>(Start, { issueId: second.id });
    expect(next.startIssueTimer.stoppedSeconds).toBe(600);
  });

  test("an unverified e-mail cannot start or log, and the time reads FORBIDDEN without a call", async () => {
    // The owner signed up and has not proven the address.
    const { asOwner, project, make } = await setup(true, false);
    mapProject(project.id);
    const issue = await make("Unverified");
    const started = await asOwner.attempt(Start, { issueId: issue.id });
    expect(codeOf(started)).toBe("time.errors.email-unverified");
    const logged = await asOwner.attempt(Log, {
      issueId: issue.id,
      input: { date: "2026-11-02", durationSeconds: 600 },
    });
    expect(codeOf(logged)).toBe("time.errors.email-unverified");
    resetCalls();
    const read = await asOwner.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent.status).toBe("FORBIDDEN");
    expect(read.issue.timeSpent.totalSeconds).toBeNull();
    expect(calls()).toEqual([]);
  });

  test("an account that is not a member in chronix: FORBIDDEN on reads, forbidden on writes", async () => {
    const { member, asMember, project, make } = await setup(true, true, {
      everyoneIsMember: false,
    });
    mapProject(project.id);
    const issue = await make("Not a member");
    const read = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(read.issue.timeSpent.status).toBe("FORBIDDEN");
    expect(read.issue.timeSpent.totalSeconds).toBeNull();
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.forbidden",
    );
    expect(
      codeOf(
        await asMember.attempt(Log, {
          issueId: issue.id,
          input: { date: "2026-11-02", durationSeconds: 600 },
        }),
      ),
    ).toBe("time.errors.forbidden");
    fake.addMember(member.email);
    const back = await asMember.call<{ issue: { timeSpent: TimeSpent } }>(
      Issue,
      { key: issue.key },
    );
    expect(back.issue.timeSpent.status).toBe("AVAILABLE");
  });

  test("logIssueTime logs on the issue, as the acting member", async () => {
    const { member, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Log me");
    resetCalls();
    const logged = await asMember.call<{
      logIssueTime: { date: string; durationSeconds: number };
    }>(Log, {
      issueId: issue.id,
      input: { date: "2026-11-12", durationSeconds: 1800, billable: false },
    });
    expect(logged.logIssueTime).toMatchObject({
      date: "2026-11-12",
      durationSeconds: 1800,
      billable: false,
    });
    expect(calls().find((c) => c.op === "logTime")).toMatchObject({
      actor: member.email,
      input: { externalRef: { kind: "issue", id: issue.id } },
    });
  });

  test("the chronix link codes added to contract v1 have their own errors", async () => {
    const { asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("New codes");
    const cases: [string, string][] = [
      ["links.project-archived", "time.errors.project-archived"],
      ["links.project-mapped", "time.errors.project-mapped"],
      ["time.archived", "time.errors.archived"],
      [
        "catalogue.project-not-found",
        "time.errors.catalogue-project-not-found",
      ],
      // Revoked during the request: treated like a refused key.
      ["links.revoked", "time.errors.invalid-key"],
    ];
    for (const [chronixCode, code] of cases) {
      fake.failNext(chronixCode);
      expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
        code,
      );
    }
  });

  test("an archived pulsarix project refuses startIssueTimer and logIssueTime, not stopIssueTimer", async () => {
    const { member, asOwner, asMember, project, make } = await setup();
    mapProject(project.id);
    const issue = await make("Archived soon");
    await asMember.call(Start, { issueId: issue.id });
    await asOwner.call(ArchiveProject, { id: project.id });
    resetCalls();
    const start = await asMember.attempt(Start, { issueId: issue.id });
    expect(codeOf(start)).toBe("time.errors.pulsarix-project-archived");
    const log = await asMember.attempt(Log, {
      issueId: issue.id,
      input: { date: "2026-11-12", durationSeconds: 600 },
    });
    expect(codeOf(log)).toBe("time.errors.pulsarix-project-archived");
    expect(calls().filter((c) => c.op !== "runningTimer")).toEqual([]);
    // The timer started before the archive can still be stopped.
    const stopped = await asMember.call<{
      stopIssueTimer: { id: string } | null;
    }>(Stop, { issueId: issue.id });
    expect(stopped.stopIssueTimer).not.toBeNull();
    expect(calls().find((c) => c.op === "stopTimer")).toMatchObject({
      actor: member.email,
    });
  });

  test("refusals: not linked, not mapped, locked period, viewer, outage", async () => {
    const { asOwner, asMember, asViewer, project, make } = await setup();
    const issue = await make("Edge cases");
    // chronix has no mapping for the project yet.
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.project-not-mapped",
    );
    mapProject(project.id);
    fake.lockPeriod("2026-01-01");
    expect(
      codeOf(
        await asMember.attempt(Log, {
          issueId: issue.id,
          input: { date: "2026-01-01", durationSeconds: 600 },
        }),
      ),
    ).toBe("time.errors.period-locked");
    // A viewer reads time, never writes it.
    expect(codeOf(await asViewer.attempt(Start, { issueId: issue.id }))).toBe(
      "auth.errors.forbidden",
    );
    // chronix down: a mutation says 503, it cannot pretend.
    fake.goDown();
    const down = await asMember.attempt(Start, { issueId: issue.id });
    expect(codeOf(down)).toBe("time.errors.unavailable");
    fake.comeUp();
    // Unlinked: nothing to call.
    await asOwner.call(Unlink);
    expect(codeOf(await asMember.attempt(Start, { issueId: issue.id }))).toBe(
      "time.errors.not-linked",
    );
    // Out-of-range durations are refused before chronix is asked.
    expect(
      (
        await asMember.attempt(Log, {
          issueId: issue.id,
          input: { date: "2026-11-13", durationSeconds: 5 },
        })
      ).errors?.length,
    ).toBeGreaterThan(0);
  });
});

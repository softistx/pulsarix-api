import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  Board,
  ChangeRole,
  CreateIssue,
  type Event,
  type IssueEvent,
  IssueLive,
  journal,
  Reports,
  setup,
  UpdateIssue,
} from "~/activity";
import { authApp } from "~/auth";
import { realtime } from "../../../config/redis";
import { backoff, writeConflict } from "../../../core/shared/locked";
import { registerIssueChange } from "../../issues/public";
import { STREAM_LIMITS } from "../activity.resolver-support";

const kit = authApp();

describe("when publishing goes wrong", () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  test("a write conflict runs the write again: one journal row, one event", async () => {
    const { asOwner, project, owner, live } = await setup(kit);
    const board = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    await Bun.sleep(100);
    // The first attempt is journalled, then loses to a concurrent writer: its
    // transaction rolls back, and the write runs again.
    let attempts = 0;
    restore.push(
      registerIssueChange(async () => {
        attempts += 1;
        if (attempts === 1) throw writeConflict();
        return undefined;
      }),
    );
    const pause = spyOn(backoff, "ms").mockReturnValue(0);
    restore.push(() => pause.mockRestore());

    const { createIssue: created } = await asOwner.call<{
      createIssue: { id: string };
    }>(CreateIssue, { input: { projectId: project.id, title: "Twice" } });

    expect(attempts).toBe(2);
    // Run again by `retryWriteConflicts` (one pause), not by the driver.
    expect(pause).toHaveBeenCalledTimes(1);
    const { nodes } = await journal(asOwner, { projectId: project.id });
    expect(nodes.map((row) => row.verb)).toEqual(["created"]);
    expect(nodes[0]?.issueId).toBe(created.id);
    expect((await board.next())?.data?.projectBoard.verb).toBe("created");
    expect(await board.quiet()).toBe(true);
    await board.close();
  });

  test("a stream ends once the viewer's role no longer allows it", async () => {
    const { asOwner, organisation, project, member, live } = await setup(kit);
    const was = STREAM_LIMITS.checkEveryMs;
    STREAM_LIMITS.checkEveryMs = 50;
    restore.push(() => {
      STREAM_LIMITS.checkEveryMs = was;
    });
    // Reporting is for those who write issues; a member does, a viewer does not.
    const reports = await live(member.token)(Reports, {
      projectId: project.id,
    });
    restore.push(() => {
      void reports.close();
    });
    const report = (reportId: string) =>
      realtime.channels.clientReportReceived.publish({
        organisationId: organisation.id,
        projectId: project.id,
        reportId,
        title: reportId,
        at: new Date().toISOString(),
      });
    // Positive control: while allowed, an event arrives.
    await Bun.sleep(100);
    await report("before");
    const heard = await reports.next(1_000);
    expect(heard?.data).toMatchObject({
      clientReportReceived: { reportId: "before" },
    });

    await asOwner.call(ChangeRole, { id: member.id, role: "viewer" });

    // The recheck runs on its own, with no event to prompt it: the stream ends
    // well before the wait would time out (a timeout also reads as null).
    const started = Date.now();
    const ended = await reports.next(3_000);
    expect(Date.now() - started).toBeLessThan(1_500);
    if (ended) expect(ended.errors).toBeDefined();

    // And it stays closed: a later event is not delivered.
    await report("after");
    expect(await reports.next(500)).toBeNull();
  });

  test("a failed publish is logged and skipped: the write stands", async () => {
    const { asOwner, project, owner, live, issue } = await setup(kit);
    const board = await live(owner.token)<Event>(Board, {
      projectId: project.id,
    });
    const seen = await issue("Seen");
    const one = await live(owner.token)<IssueEvent>(IssueLive, {
      issueId: seen.id,
    });
    await Bun.sleep(100);
    // The board's publish fails; the issue's own topic still hears.
    const publish = spyOn(
      realtime.channels.projectBoard,
      "publish",
    ).mockRejectedValue(new Error("redis went away"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    restore.push(
      () => publish.mockRestore(),
      () => warn.mockRestore(),
    );

    const { createIssue: created } = await asOwner.call<{
      createIssue: { id: string };
    }>(CreateIssue, { input: { projectId: project.id, title: "Still here" } });
    await asOwner.call(UpdateIssue, {
      id: seen.id,
      input: { title: "Seen again" },
    });

    expect((await one.next())?.data?.issueChanged.verb).toBe("updated");
    expect(publish).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "after-commit work failed",
      expect.any(Error),
    );
    const { nodes } = await journal(asOwner, { projectId: project.id });
    expect(nodes.map((row) => row.verb)).toEqual([
      "updated",
      "created",
      "created",
    ]);
    expect(nodes.some((row) => row.issueId === created.id)).toBe(true);
    // The board heard the first create, then nothing: its publishes failed.
    expect((await board.next())?.data?.projectBoard.verb).toBe("created");
    expect(await board.quiet()).toBe(true);
    await board.close();
    await one.close();
  });
});

import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  Accept,
  EditComment,
  IssueFlag,
  Journal,
  Notifications,
  ReportFlag,
  Watch,
  world,
} from "~/thread";

describe("the request thread", () => {
  test("a reporter's message sets clientWaiting, a public reply clears it", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    // Before any issue: the report waits, the issue starts waiting.
    await w.say("ada", a, "Hello?");
    const flagged = async () =>
      (
        await w.kit.asOwner.call<{
          clientReports: { nodes: { id: string; clientWaiting: boolean }[] };
        }>(ReportFlag, { projectId: w.kit.project.id })
      ).clientReports.nodes.find((node) => node.id === a)?.clientWaiting;
    expect(await flagged()).toBe(true);
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    const { issueId } = acceptClientReport;
    const issueWaits = async () =>
      (
        await w.kit.asOwner.call<{ issue: { clientWaiting: boolean } }>(
          IssueFlag,
          { key: "ABC-1" },
        )
      ).issue.clientWaiting;
    expect(await issueWaits()).toBe(true);
    // An internal comment answers nobody.
    await w.comment(issueId, "internal", false);
    expect(await issueWaits()).toBe(true);
    const { addComment } = await w.comment(issueId, "we look", true);
    expect(await issueWaits()).toBe(false);
    expect(await flagged()).toBe(false);
    // Writing again sets it again, with the issue already accepted.
    w.kit.kit.clock.advance(1_000);
    await w.say("ada", a, "Thanks");
    expect(await flagged()).toBe(true);
    expect(await issueWaits()).toBe(true);
    // Editing the old reply does not hide the newer message.
    await w.kit.asOwner.call(EditComment, {
      id: addComment.id,
      input: { body: "we look, really" },
    });
    expect(await flagged()).toBe(true);
    await w.comment(issueId, "fixed", true);
    expect(await issueWaits()).toBe(false);
  });

  test("tells the watchers, and journals clientReplied", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    await w.kit.asOwner.call(Watch, { id: acceptClientReport.issueId });
    await w.say("ada", a, "Any news?");
    const { notifications } = await w.kit.asOwner.call<{
      notifications: { nodes: { kind: string; issueKey: string }[] };
    }>(Notifications, {});
    expect(notifications.nodes.map((node) => node.kind)).toContain(
      "clientReplied",
    );
    const { activity } = await w.kit.asOwner.call<{
      activity: { nodes: { verb: string }[] };
    }>(Journal, { issueId: acceptClientReport.issueId });
    expect(activity.nodes.map((node) => node.verb)).toContain("clientReplied");
  });

  test("a reply's files get slots like a report's, and stay out of the tracking list", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const posted = await w.say("ada", a, "See this", [
      { role: "screenshot", name: "s.png", type: "image/png", size: 1_000 },
    ] as never);
    expect(posted.files).toHaveLength(1);
    const slot = await w.mongo.db.clientReportFiles.findById(
      new ObjectId(posted.files[0]?.slot),
    );
    expect(slot).toMatchObject({ role: "reply", state: "pending" });
    expect(slot?.messageId?.toHexString()).toBe(posted.messageId);
    const message = await w.mongo.db.clientReportMessages.findById(
      new ObjectId(posted.messageId),
    );
    expect(message?.fileIds.map((id) => id.toHexString())).toEqual([
      posted.files[0]?.slot as string,
    ]);
    // Over the limits of a report's files: refused before anything is made.
    const before = await w.mongo.db.clientReportMessages.count({});
    await expect(
      w.say("ada", a, "Too big", [
        {
          role: "file",
          name: "x.pdf",
          type: "application/pdf",
          size: 50_000_000,
        },
      ] as never),
    ).rejects.toThrow();
    expect(await w.mongo.db.clientReportMessages.count({})).toBe(before);
  });
});

import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { Accept, Comments, Decline, IssueFlag, world } from "~/thread";
import { postMessage } from "./messages.service";
import { eraseSettled } from "./retention.service";
import { ownedReport } from "./thread.service";

describe("the request thread", () => {
  test("refuses an empty or too long body, and a declined request", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    await expect(w.say("ada", a, "  ")).rejects.toThrow();
    await expect(w.say("ada", a, "x".repeat(5_001))).rejects.toThrow();
    expect((await w.say("ada", a, "x".repeat(5_000))).messageId).toBeString();
    await w.kit.asOwner.call(Decline, { id: a, reason: "No" });
    const error = await w.say("ada", a, "Please?").catch((e) => e);
    expect((error as { extensions?: { code?: string } }).extensions?.code).toBe(
      "intake.errors.request-declined",
    );
  });

  test("an erased message leaves both threads", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    const posted = await w.say("ada", a, "My phone is 555");
    await w.mongo.db.clientReportMessages.update(
      new ObjectId(posted.messageId),
      { body: "", erasedAt: new Date() },
    );
    expect(await w.thread("ada", a)).toEqual([]);
    const { comments } = await w.kit.asOwner.call<{
      comments: { nodes: unknown[] };
    }>(Comments, { issueId: acceptClientReport.issueId });
    expect(comments.nodes).toEqual([]);
  });

  test("erasing a settled report stops its issue waiting", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    await w.say("ada", a, "Hello?");
    await w.mongo.db.clientReports.update(new ObjectId(a), {
      state: "closed",
      closedAt: new Date(0),
    });
    expect(await eraseSettled(w.mongo, new Date())).toBe(1);
    const { issue } = await w.kit.asOwner.call<{
      issue: { clientWaiting: boolean };
    }>(IssueFlag, { key: "ABC-1" });
    expect(issue.clientWaiting).toBe(false);
    expect(acceptClientReport.issueId).toBeString();
  });

  test("a report that got its issue meanwhile still tells the team", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const stale = await ownedReport(w.mongo, w.reporter("ada"), a);
    await w.kit.asOwner.call(Accept, { id: a });
    await postMessage(w.kit.intake, w.mongo, w.key, stale, { body: "late" });
    const { issue } = await w.kit.asOwner.call<{
      issue: { clientWaiting: boolean };
    }>(IssueFlag, { key: "ABC-1" });
    expect(issue.clientWaiting).toBe(true);
  });
});

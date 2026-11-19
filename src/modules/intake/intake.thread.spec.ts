import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { goodReport, type IntakeKit, intakeKit } from "~/intake";
import { coreMongo, tenancy } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { IDENTITY_HEADER, reporterKeyOf } from "./intake.identity";
import { postMessage } from "./intake.messages";
import { eraseSettled } from "./intake.retention";
import type { IntakeMongo } from "./intake.submit";
import {
  markRead,
  ownedReport,
  readThread,
  unreadCount,
  unreadCounts,
} from "./intake.thread";

// A16: the request thread (plan §19): messages, reply files, unread counts,
// "the client is waiting" and the read side of the team.

const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) { secret }
}`;
const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
const Link = `mutation($id: ID!, $issueId: ID!) {
  linkClientReport(id: $id, issueId: $issueId) { id issueId }
}`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
const EditComment = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { id }
}`;
const Comments = `query($issueId: ID!) {
  comments(issueId: $issueId) {
    nodes { id body public source reportId reporterName authorId }
  }
}`;
const IssueFlag = `query($key: String!) { issue(key: $key) { id clientWaiting } }`;
const ReportFlag = `query($projectId: ID!) {
  clientReports(projectId: $projectId) { nodes { id clientWaiting } }
}`;
const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
const Notifications = `query { notifications(first: 20) { nodes { kind issueKey } } }`;
const Journal = `query($issueId: ID!) { activity(issueId: $issueId) { nodes { verb } } }`;

const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

// A host that signs its users' tokens with the key's identity secret.
async function host(kit: IntakeKit) {
  const secret = (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(Generate, { keyId: kit.key.id })
  ).generateWidgetIdentitySecret.secret;
  const token = (sub: string) => {
    const iat = Math.floor(Date.now() / 1000);
    const body = b64(
      JSON.stringify({
        sub,
        name: sub,
        aud: kit.key.publicKey,
        iat,
        exp: iat + 3600,
      }),
    );
    return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
  };
  const file = async (sub: string) => {
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
    const { body } = await kit.submit(goodReport({ title: `By ${sub}` }), {
      [IDENTITY_HEADER]: token(sub),
    });
    const data = body?.data as unknown as {
      submitClientReport: { reportId: string };
    };
    return data.submitClientReport.reportId;
  };
  return { file };
}

async function world() {
  const kit = await intakeKit();
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const key = await coreMongo.db.widgetKeys.findFirst({
    publicKey: kit.key.publicKey,
  });
  if (!key) throw new Error("no key");
  const reporter = (sub: string) => ({
    keyId: key._id,
    reporterKey: reporterKeyOf(key.id, sub),
  });
  const reportOf = (id: string) =>
    mongo.db.clientReports.findById(new ObjectId(id)) as Promise<never>;
  const say = async (sub: string, id: string, body: string, files = []) =>
    postMessage(
      kit.intake,
      mongo,
      key,
      await ownedReport(mongo, reporter(sub), id),
      { body, files },
    );
  const comment = (issueId: string, body: string, isPublic: boolean) =>
    kit.asOwner.call<{ addComment: { id: string } }>(AddComment, {
      issueId,
      input: { body, public: isPublic },
    });
  const thread = async (sub: string, id: string) =>
    readThread(mongo, await ownedReport(mongo, reporter(sub), id));
  return {
    kit,
    mongo,
    key,
    reporter,
    reportOf,
    say,
    comment,
    thread,
    host: await host(kit),
  };
}

describe("the request thread", () => {
  test("two reports on one issue each see the public reply, never the other's messages", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    const issueId = acceptClientReport.issueId;
    await w.comment(issueId, "before the link", true);
    const b = await w.host.file("bob");
    await w.kit.asOwner.call(Link, { id: b, issueId });
    await w.say("ada", a, "Ada writes");
    await w.say("bob", b, "Bob writes");
    await w.comment(issueId, "internal note", false);
    await w.comment(issueId, "public answer", true);

    const forAda = await w.thread("ada", a);
    expect(forAda.map((entry) => [entry.from, entry.body])).toEqual([
      ["team", "before the link"],
      ["reporter", "Ada writes"],
      ["team", "public answer"],
    ]);
    // Bob was linked later: no reply from before the link, none of Ada's text.
    const forBob = await w.thread("bob", b);
    expect(forBob.map((entry) => [entry.from, entry.body])).toEqual([
      ["reporter", "Bob writes"],
      ["team", "public answer"],
    ]);
    for (const entry of [...forAda, ...forBob]) {
      expect(entry.body).not.toContain("internal note");
    }
    // Another reporter's report is a 404, like an unknown one.
    await expect(ownedReport(w.mongo, w.reporter("bob"), a)).rejects.toThrow();
    await expect(
      ownedReport(w.mongo, w.reporter("ada"), "nope"),
    ).rejects.toThrow();
  });

  test("the team reads the messages as CLIENT entries, stored once", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    const { issueId } = acceptClientReport;
    await w.comment(issueId, "ok", true);
    await w.say("ada", a, "Still broken");
    const { comments } = await w.kit.asOwner.call<{
      comments: {
        nodes: {
          body: string;
          public: boolean;
          source: string;
          reportId: string | null;
          reporterName: string | null;
          authorId: string | null;
        }[];
      };
    }>(Comments, { issueId });
    expect(comments.nodes.map((node) => node.source)).toEqual([
      "TEAM",
      "CLIENT",
    ]);
    expect(comments.nodes[1]).toMatchObject({
      body: "Still broken",
      public: false,
      reportId: a,
      reporterName: "ada",
      authorId: null,
    });
    // Not stored twice: the comments collection holds the team's only.
    expect(await w.mongo.db.comments.count({})).toBe(1);
  });

  test("counts the team's public replies not read yet", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    const { issueId } = acceptClientReport;
    await w.comment(issueId, "one", true);
    await w.comment(issueId, "internal", false);
    await w.comment(issueId, "two", true);
    const b = await w.host.file("bob");
    const owned = async (sub: string, id: string) =>
      ownedReport(w.mongo, w.reporter(sub), id);
    expect(await unreadCount(w.mongo, await owned("ada", a))).toBe(2);
    // Not linked, no issue: nothing to read.
    expect(await unreadCount(w.mongo, await owned("bob", b))).toBe(0);
    await w.kit.asOwner.call(Link, { id: b, issueId });
    const reports = [await owned("ada", a), await owned("bob", b)];
    expect((await unreadCounts(w.mongo, reports)).get(b)).toBe(0);

    await markRead(w.mongo, reports[0] as never, new Date());
    expect(await unreadCount(w.mongo, await owned("ada", a))).toBe(0);
    w.kit.kit.clock.advance(1_000);
    await w.comment(issueId, "three", true);
    expect(await unreadCount(w.mongo, await owned("ada", a))).toBe(1);
    expect(await unreadCount(w.mongo, await owned("bob", b))).toBe(1);
    // The cursor never moves back.
    const read = await owned("ada", a);
    await markRead(w.mongo, read, new Date(0));
    expect((await owned("ada", a)).reporterReadAt).toEqual(read.reporterReadAt);
  });

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

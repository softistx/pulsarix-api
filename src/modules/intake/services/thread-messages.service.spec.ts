import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import {
  Accept,
  Comments,
  DeleteComment,
  EditComment,
  Link,
  world,
} from "~/thread";
import {
  markRead,
  ownedReport,
  unreadCount,
  unreadCounts,
} from "./thread.service";

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

  test("a CLIENT entry cannot be edited or deleted by the team", async () => {
    const w = await world();
    const a = await w.host.file("ada");
    const { acceptClientReport } = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: a });
    const { issueId } = acceptClientReport;
    await w.say("ada", a, "Still broken");
    const { comments } = await w.kit.asOwner.call<{
      comments: { nodes: { id: string; source: string }[] };
    }>(Comments, { issueId });
    const client = comments.nodes.find((node) => node.source === "CLIENT");
    if (!client) throw new Error("no CLIENT entry");
    // Its id is a message id: the comments collection has no such row.
    const edit = await w.kit.asOwner.attempt(EditComment, {
      id: client.id,
      input: { body: "tampered" },
    });
    const del = await w.kit.asOwner.attempt(DeleteComment, { id: client.id });
    for (const failure of [edit, del]) {
      expect(codeOf(failure)).toBe("comments.errors.not-found");
    }
    const stored = await w.thread("ada", a);
    expect(stored.map((entry) => entry.body)).toEqual(["Still broken"]);
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
});

import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOfBody } from "~/intake";
import {
  AddComment,
  DAY,
  Decline,
  Journal,
  Notifications,
  Watch,
  world,
} from "~/requests";

describe("reply, resolve and reopen", () => {
  test("a reply lands in the thread and a declined request refuses reply and reopen", async () => {
    const w = await world();
    const a = await w.file("ada");
    const reply = (
      await w.data("ada", "replyToRequest", {
        id: a,
        input: { body: "More detail" },
      })
    )["replyToRequest"] as unknown as { messageId: string; files: unknown[] };
    expect(reply.messageId).toBeTruthy();
    const detail = (await w.data("ada", "request", { id: a }))[
      "request"
    ] as unknown as {
      thread: { from: string; body: string }[];
    };
    expect(detail.thread.map((t) => t.body)).toEqual(["More detail"]);

    const b = await w.file("bob");
    await w.kit.asOwner.call(Decline, { id: b, reason: "Not for us" });
    for (const [id, vars] of [
      ["replyToRequest", { id: b, input: { body: "please" } }],
      ["reopenRequest", { id: b }],
      ["resolveRequest", { id: b }],
    ] as const) {
      const { response } = await w.as("bob", id, vars);
      expect(response.status).toBe(409);
    }
    const shown = (await w.data("bob", "request", { id: b }))[
      "request"
    ] as unknown as {
      publicState: string;
      canReply: boolean;
    };
    expect(shown.publicState).toBe("declined");
    expect(shown.canReply).toBe(false);
  });

  test("resolve marks the issue and tells the team, reopen undoes it, the status never moves", async () => {
    const w = await world();
    const a = await w.file("ada");
    const issueId = await w.accept(a);
    await w.kit.asOwner.call(Watch, { id: issueId });
    const before = await w.mongo.db.issues.findById(new ObjectId(issueId));

    const resolved = (await w.data("ada", "resolveRequest", { id: a }))[
      "resolveRequest"
    ] as unknown as { publicState: string };
    expect(resolved.publicState).toBe("resolved");
    const again = await w.data("ada", "resolveRequest", { id: a });
    expect(
      (again["resolveRequest"] as { publicState: string }).publicState,
    ).toBe("resolved");
    let issue = await w.mongo.db.issues.findById(new ObjectId(issueId));
    expect(issue?.clientMarkers).toEqual(["resolved"]);
    expect(issue?.statusId.toHexString()).toBe(before?.statusId.toHexString());

    const detail = (await w.data("ada", "request", { id: a }))[
      "request"
    ] as unknown as {
      canReopen: boolean;
    };
    expect(detail.canReopen).toBe(true);

    const reopened = (await w.data("ada", "reopenRequest", { id: a }))[
      "reopenRequest"
    ] as unknown as { publicState: string };
    expect(reopened.publicState).not.toBe("resolved");
    issue = await w.mongo.db.issues.findById(new ObjectId(issueId));
    expect(issue?.clientMarkers).toEqual(["reopened"]);

    const verbs = (
      await w.kit.asOwner.call<{ activity: { nodes: { verb: string }[] } }>(
        Journal,
        { issueId },
      )
    ).activity.nodes.map((n) => n.verb);
    expect(verbs).toContain("clientResolved");
    expect(verbs).toContain("clientReopened");
    expect(verbs.filter((v) => v === "clientResolved")).toHaveLength(1);
    const kinds = (
      await w.kit.asOwner.call<{
        notifications: { nodes: { kind: string }[] };
      }>(Notifications, {})
    ).notifications.nodes.map((n) => n.kind);
    expect(kinds).toContain("clientResolved");
    expect(kinds).toContain("clientReopened");
  });

  test("reopening after 30 days answers 409", async () => {
    const w = await world();
    const a = await w.file("ada");
    await w.accept(a);
    await w.data("ada", "resolveRequest", { id: a });
    await w.mongo.db.clientReports.raw.updateOne(
      { _id: new ObjectId(a) },
      { $set: { resolvedByReporterAt: new Date(Date.now() - 31 * DAY) } },
    );
    const { response, body } = await w.as("ada", "reopenRequest", { id: a });
    expect(response.status).toBe(409);
    expect(codeOfBody(body)).toBe("intake.errors.reopen-expired");
    const detail = (await w.data("ada", "request", { id: a }))[
      "request"
    ] as unknown as {
      canReopen: boolean;
    };
    expect(detail.canReopen).toBe(false);
  });

  test("the e-mail switch applies to every request of the reporter only", async () => {
    const w = await world();
    const a = await w.file("ada");
    const b = await w.file("bob");
    await w.data("ada", "setRequestEmails", { on: false });
    const mine = (await w.data("ada", "myRequests", {}))[
      "myRequests"
    ] as unknown as {
      emailsOn: boolean;
    };
    const his = (await w.data("bob", "myRequests", {}))[
      "myRequests"
    ] as unknown as {
      emailsOn: boolean;
    };
    expect(mine.emailsOn).toBe(false);
    expect(his.emailsOn).toBe(true);
    expect(
      (await w.mongo.db.clientReports.findById(new ObjectId(b)))?.emailsOff,
    ).toBe(false);
    expect(
      (await w.mongo.db.clientReports.findById(new ObjectId(a)))?.emailsOff,
    ).toBe(true);
  });
});

type Page = {
  nodes: { id: string }[];
  endCursor: string | null;
  hasNextPage: boolean;
};

describe("the request list cursor", () => {
  test("a page boundary holds when the request it ended on is read meanwhile", async () => {
    const w = await world();
    // Listed newest first: c, b, a. A reply on a and on c puts them first.
    const a = await w.file("ada");
    const b = await w.file("ada");
    const c = await w.file("ada");
    const issues = { a: await w.accept(a), b: await w.accept(b) };
    const issueC = await w.accept(c);
    for (const issueId of [issues.a, issueC]) {
      await w.kit.asOwner.call(AddComment, {
        issueId,
        input: { body: "Looking", public: true },
      });
    }
    const page = async (after: string | null, first = 1) =>
      (await w.data("ada", "myRequests", { first, after }))[
        "myRequests"
      ] as unknown as Page;

    const one = await page(null);
    expect(one.nodes.map((n) => n.id)).toEqual([c]);
    // The reporter reads c: it leaves the unread group between the pages.
    await w.data("ada", "markRequestRead", { id: c });
    const two = await page(one.endCursor);
    expect(two.nodes.map((n) => n.id)).toEqual([a]);
    // Nothing after the boundary is skipped or repeated (c, read meanwhile,
    // is the one request that may show again, in the read group).
    const rest = await page(two.endCursor, 5);
    expect(rest.nodes.map((n) => n.id)).toContain(b);
    expect(rest.nodes.map((n) => n.id)).not.toContain(a);
    expect(rest.hasNextPage).toBe(false);
  });

  test("still takes a bare id and refuses an unknown one", async () => {
    const w = await world();
    const a = await w.file("ada");
    const b = await w.file("ada");
    const bare = (await w.data("ada", "myRequests", { first: 5, after: b }))[
      "myRequests"
    ] as unknown as Page;
    expect(bare.nodes.map((n) => n.id)).toEqual([a]);
    const { body } = await w.as("ada", "myRequests", {
      after: "u:000000000000000000000000",
    });
    expect(codeOfBody(body)).toBe("validation.errors.invalid-input");
  });
});

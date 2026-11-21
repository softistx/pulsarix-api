import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { codeOfBody, goodReport, type IntakeKit, intakeKit } from "~/intake";
import { tenancy } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { LIVE_REQUESTS_PATH } from "./intake.http";
import { IDENTITY_HEADER } from "./intake.identity";
import { eraseMyData } from "./intake.requests.actions";
import { openLedger } from "./intake.requests.live";
import type { Session } from "./intake.requests.session";
import type { IntakeMongo } from "./intake.submit";
import { streamTiming } from "./routes/live.routes";

// A17: the public request endpoints and the live stream (plan §19).

const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) { secret }
}`;
const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
const Notifications = `query { notifications(first: 20) { nodes { kind issueKey } } }`;
const Journal = `query($issueId: ID!) { activity(issueId: $issueId) { nodes { verb } } }`;

const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
const DAY = 86_400_000;

type Data = Record<string, Record<string, unknown>>;

async function world() {
  const kit = await intakeKit();
  const secret = (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(Generate, { keyId: kit.key.id })
  ).generateWidgetIdentitySecret.secret;
  const token = (sub: string, lifetime = 3600) => {
    const iat = Math.floor(Date.now() / 1000);
    const body = b64(
      JSON.stringify({
        sub,
        name: sub,
        aud: kit.key.publicKey,
        iat,
        exp: iat + lifetime,
      }),
    );
    return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
  };
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const clearIp = () =>
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  const file = async (sub: string, extra: Record<string, unknown> = {}) => {
    clearIp();
    const { body } = await kit.submit(
      goodReport({ title: `By ${sub}`, ...extra }),
      { [IDENTITY_HEADER]: token(sub) },
    );
    return (
      body as unknown as { data: { submitClientReport: { reportId: string } } }
    ).data.submitClientReport.reportId;
  };
  // A persisted operation as the reporter `sub` makes it.
  const as = (
    sub: string | null,
    id: string,
    variables: Record<string, unknown>,
  ) =>
    kit.op(
      id,
      { publicKey: kit.key.publicKey, ...variables },
      sub === null ? {} : { [IDENTITY_HEADER]: token(sub) },
    );
  const data = async (
    sub: string,
    id: string,
    variables: Record<string, unknown>,
  ) => {
    const { response, body } = await as(sub, id, variables);
    expect(response.status).toBe(200);
    return body?.data as unknown as Data;
  };
  const accept = async (reportId: string) => {
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: reportId });
    return acceptClientReport.issueId;
  };
  const stream = (sub: string, lifetime = 3600, key = kit.key.publicKey) =>
    openStream(kit, token(sub, lifetime), key);
  return { kit, token, mongo, file, as, data, accept, stream, clearIp };
}

// The stream as a browser's `fetch` reads it: events by name, in order.
async function openStream(
  kit: IntakeKit,
  identity: string | null,
  key: string,
) {
  const controller = new AbortController();
  const response = await kit.kit.app.fetch(
    new Request(
      `https://api.pulsarix.test${LIVE_REQUESTS_PATH}?key=${encodeURIComponent(key)}`,
      {
        signal: controller.signal,
        headers: {
          origin: kit.site,
          ...(identity && { [IDENTITY_HEADER]: identity }),
        },
      },
    ),
  );
  const events: { event: string; data: unknown }[] = [];
  let ended = false;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = block.match(/^event: (.*)$/m)?.[1];
          const raw = block.match(/^data: (.*)$/m)?.[1];
          if (name && raw) events.push({ event: name, data: JSON.parse(raw) });
        }
      }
    } catch {}
    ended = true;
  })();
  return {
    response,
    events,
    async next(name: string, ms = 2_000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const at = events.findIndex((e) => e.event === name);
        if (at >= 0)
          return events.splice(at, 1)[0]?.data as Record<string, unknown>;
        if (ended) return null;
        await Bun.sleep(10);
      }
      return null;
    },
    get ended() {
      return ended;
    },
    async untilEnd(ms = 4_000) {
      const until = Date.now() + ms;
      while (!ended && Date.now() < until) await Bun.sleep(20);
      return ended;
    },
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await pump;
    },
  };
}

describe("My requests and one request", () => {
  test("lists only the reporter's requests, with counts, and reads one with its thread", async () => {
    const w = await world();
    const a1 = await w.file("ada");
    const a2 = await w.file("ada", { title: "Second" });
    const b1 = await w.file("bob");
    const issue = await w.accept(a1);
    await w.kit.asOwner.call(AddComment, {
      issueId: issue,
      input: { body: "We are on it", public: true },
    });
    await w.kit.asOwner.call(AddComment, {
      issueId: issue,
      input: { body: "internal", public: false },
    });

    const mine = (await w.data("ada", "myRequests", { filter: "ALL" }))[
      "myRequests"
    ] as unknown as {
      nodes: { id: string; unread: number; publicState: string }[];
      counts: { open: number; all: number };
      unread: number;
      emailsOn: boolean;
    };
    const ids = mine.nodes.map((n) => n.id);
    expect(ids.sort()).toEqual([a1, a2].sort());
    expect(ids).not.toContain(b1);
    expect(mine.counts).toMatchObject({ open: 2, all: 2 });
    expect(mine.unread).toBe(1);
    expect(mine.nodes[0]?.id).toBe(a1);
    expect(mine.emailsOn).toBe(true);

    const detail = (await w.data("ada", "request", { id: a1 }))[
      "request"
    ] as unknown as {
      thread: { from: string; body: string }[];
      canReply: boolean;
      canReopen: boolean;
    };
    expect(detail.thread.map((t) => t.body)).toEqual(["We are on it"]);
    expect(detail.thread[0]?.from).toBe("team");
    expect(detail.canReply).toBe(true);
    expect(detail.canReopen).toBe(false);

    const read = (await w.data("ada", "markRequestRead", { id: a1 }))[
      "markRequestRead"
    ] as unknown as { count: number };
    expect(read.count).toBe(0);
  });

  test("a foreign request answers 404 on every operation", async () => {
    const w = await world();
    const a = await w.file("ada");
    for (const [id, vars] of [
      ["request", { id: a }],
      ["replyToRequest", { id: a, input: { body: "mine now" } }],
      ["resolveRequest", { id: a }],
      ["reopenRequest", { id: a }],
      ["markRequestRead", { id: a }],
    ] as const) {
      const { response } = await w.as("bob", id, vars);
      expect(response.status).toBe(404);
    }
    const missing = await w.as("ada", "request", {
      id: new ObjectId().toHexString(),
    });
    expect(missing.response.status).toBe(404);
    const garbage = await w.as("ada", "request", { id: "nope" });
    expect(garbage.response.status).toBe(404);
  });

  test("a missing, forged or malformed token is refused with 401", async () => {
    const w = await world();
    const a = await w.file("ada");
    expect((await w.as(null, "myRequests", {})).response.status).toBe(401);
    expect((await w.as(null, "request", { id: a })).response.status).toBe(401);
    for (const identity of [
      "garbage",
      `${w.token("ada").split(".")[0]}.AAAA`,
    ]) {
      const { response, body } = await w.kit.op(
        "myRequests",
        { publicKey: w.kit.key.publicKey },
        { [IDENTITY_HEADER]: identity },
      );
      expect(response.status).toBe(401);
      expect(codeOfBody(body)).toBe("intake.errors.identity-invalid");
    }
  });

  test("a request of another key is not reachable with this key's token", async () => {
    const w = await world();
    const other = await intakeKit();
    const theirs = await (async () => {
      (
        other.limits as unknown as {
          intakeIpKey: { counts: Map<string, number> };
        }
      ).intakeIpKey.counts.clear();
      const { body } = await other.submit(goodReport());
      return (
        body as unknown as {
          data: { submitClientReport: { reportId: string } };
        }
      ).data.submitClientReport.reportId;
    })();
    const { response } = await w.as("ada", "request", { id: theirs });
    expect(response.status).toBe(404);
  });
});

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

describe("delete my data", () => {
  test("erases the reporter's requests, leaves the issue marked deleted, once an hour", async () => {
    const w = await world();
    const a = await w.file("ada");
    const b = await w.file("bob");
    const issueId = await w.accept(a);

    const erased = (await w.data("ada", "eraseMyData", {}))[
      "eraseMyData"
    ] as unknown as {
      requests: number;
    };
    expect(erased.requests).toBe(1);
    const report = await w.mongo.db.clientReports.findById(new ObjectId(a));
    expect(report?.erasedAt).not.toBeNull();
    expect(report?.reporterKey).toBeNull();
    const issue = await w.mongo.db.issues.findById(new ObjectId(issueId));
    expect(issue?.clientMarkers).toContain("deleted");
    expect(
      (await w.mongo.db.clientReports.findById(new ObjectId(b)))?.erasedAt,
    ).toBeNull();

    const list = (await w.data("ada", "myRequests", { filter: "ALL" }))[
      "myRequests"
    ] as unknown as {
      nodes: unknown[];
    };
    expect(list.nodes).toHaveLength(0);
    const second = await w.as("ada", "eraseMyData", {});
    expect(second.response.status).toBe(429);
  });
});

describe("delete my data, when it fails", () => {
  test("a failed erasure does not spend the hour", async () => {
    const w = await world();
    await w.file("ada");
    const session = {
      key: w.kit.key,
      reporter: { keyId: new ObjectId(w.kit.key.id), reporterKey: "ada" },
      mongo: {
        db: {
          clientReports: {
            findMany: async () => {
              throw new Error("database down");
            },
          },
        },
      },
    };
    await expect(eraseMyData(w.kit.intake, session as never)).rejects.toThrow(
      "database down",
    );
    // Retried at once: the failed run spent nothing.
    const retry = await w.as("ada", "eraseMyData", {});
    expect(retry.response.status).toBe(200);
    expect(retry.body?.data?.["eraseMyData"]).toEqual({ requests: 1 });
  });
});

describe("rate limits", () => {
  test("replies are capped per reporter, reads per reporter", async () => {
    const w = await world();
    const a = await w.file("ada");
    let last = 200;
    for (let i = 0; i < 11; i += 1) {
      last = (
        await w.as("ada", "replyToRequest", { id: a, input: { body: `m${i}` } })
      ).response.status;
    }
    expect(last).toBe(429);
    const counts = (
      w.kit.limits as unknown as {
        intakeReporterRead: { counts: Map<string, number> };
      }
    ).intakeReporterRead.counts;
    for (const key of counts.keys()) counts.set(key, 120);
    const { response } = await w.as("bob", "myRequests", {});
    expect(response.status).toBe(200);
    expect((await w.as("ada", "myRequests", {})).response.status).toBe(429);
  });
});

describe("the live stream", () => {
  test("refuses a missing or foreign token and a key it does not know", async () => {
    const w = await world();
    const none = await openStream(w.kit, null, w.kit.key.publicKey);
    expect(none.response.status).toBe(401);
    await none.close();
    const bad = await openStream(w.kit, "garbage", w.kit.key.publicKey);
    expect(bad.response.status).toBe(401);
    await bad.close();
    const unknown = await openStream(w.kit, w.token("ada"), "pk_live_nope");
    expect(unknown.response.status).toBeGreaterThanOrEqual(400);
    await unknown.close();
  });

  test("an origin the key does not allow gets no stream and no CORS header", async () => {
    const w = await world();
    const response = await w.kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test${LIVE_REQUESTS_PATH}?key=${w.kit.key.publicKey}`,
        {
          headers: {
            origin: "https://evil.test",
            [IDENTITY_HEADER]: w.token("ada"),
          },
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("tells the reporter, and only them, when the team replies", async () => {
    const w = await world();
    const a = await w.file("ada");
    await w.file("bob");
    const issueId = await w.accept(a);
    const ada = await w.stream("ada");
    const bob = await w.stream("bob");
    expect(ada.response.status).toBe(200);
    expect(ada.response.headers.get("access-control-allow-origin")).toBe(
      w.kit.site,
    );
    expect(await ada.next("unread")).toEqual({ count: 0 });
    expect(await bob.next("unread")).toEqual({ count: 0 });

    await w.kit.asOwner.call(AddComment, {
      issueId,
      input: { body: "Fixed in the next release", public: true },
    });
    expect(await ada.next("request.updated")).toMatchObject({
      id: a,
      unread: 1,
    });
    expect(await ada.next("unread")).toEqual({ count: 1 });
    expect(
      bob.events.filter((e) => e.event === "request.updated"),
    ).toHaveLength(0);

    await w.data("ada", "markRequestRead", { id: a });
    expect(await ada.next("request.updated")).toMatchObject({
      id: a,
      unread: 0,
    });
    await ada.close();
    await bob.close();
  });

  test("withdrawing or deleting a public reply reaches the stream", async () => {
    const w = await world();
    const a = await w.file("ada");
    const issueId = await w.accept(a);
    const ada = await w.stream("ada");
    await ada.next("unread");
    const add = async (body: string) =>
      (
        await w.kit.asOwner.call<{ addComment: { id: string } }>(AddComment, {
          issueId,
          input: { body, public: true },
        })
      ).addComment.id;
    const first = await add("One");
    await ada.next("request.updated");
    await ada.next("unread");
    await w.kit.asOwner.call(
      `mutation($id: ID!, $input: EditCommentInput!) { editComment(id: $id, input: $input) { id } }`,
      { id: first, input: { public: false } },
    );
    expect(await ada.next("request.updated")).toMatchObject({ id: a });
    await ada.next("unread");
    const second = await add("Two");
    await ada.next("request.updated");
    await ada.next("unread");
    await w.kit.asOwner.call(`mutation($id: ID!) { deleteComment(id: $id) }`, {
      id: second,
    });
    expect(await ada.next("request.updated")).toMatchObject({ id: a });
    await ada.close();
  });

  test("a decision by the team reaches the stream", async () => {
    const w = await world();
    const a = await w.file("ada");
    const ada = await w.stream("ada");
    await ada.next("unread");
    await w.kit.asOwner.call(Decline, { id: a, reason: "No" });
    expect(await ada.next("request.updated")).toMatchObject({
      id: a,
      publicState: "declined",
    });
    await ada.close();
  });

  test("closes when the token expires", async () => {
    const w = await world();
    const ada = await w.stream("ada", 1);
    expect(ada.response.status).toBe(200);
    expect(await ada.untilEnd(5_000)).toBe(true);
    expect(ada.events.some((e) => e.event === "expired")).toBe(true);
    await ada.close();
  });

  test("a revoked key or a rotated identity secret closes an open stream", async () => {
    const before = streamTiming.recheckMs;
    streamTiming.recheckMs = 40;
    try {
      const w = await world();
      const rotated = await w.stream("ada");
      expect(rotated.response.status).toBe(200);
      await rotated.next("unread");
      await w.kit.asOwner.call(Generate, { keyId: w.kit.key.id });
      expect(await rotated.untilEnd(2_000)).toBe(true);
      expect(rotated.events.some((e) => e.event === "expired")).toBe(true);
      await rotated.close();

      const w2 = await world();
      const revoked = await w2.stream("ada");
      expect(revoked.response.status).toBe(200);
      await revoked.next("unread");
      await w2.kit.asOwner.call(
        `mutation($id: ID!) { revokeWidgetKey(id: $id) }`,
        { id: w2.kit.key.id },
      );
      expect(await revoked.untilEnd(2_000)).toBe(true);
      expect(revoked.events.some((e) => e.event === "expired")).toBe(true);
      await revoked.close();
    } finally {
      streamTiming.recheckMs = before;
    }
  });

  test("a recheck that throws keeps the stream open", async () => {
    const before = streamTiming.recheckMs;
    streamTiming.recheckMs = 30;
    const w = await world();
    const real = w.kit.intake.keyOf.bind(w.kit.intake);
    let fail = true;
    let calls = 0;
    w.kit.intake.keyOf = async (publicKey: string) => {
      if (fail) {
        calls += 1;
        throw new Error("database blip");
      }
      return real(publicKey);
    };
    try {
      fail = false;
      const ada = await w.stream("ada");
      expect(ada.response.status).toBe(200);
      await ada.next("unread");
      fail = true;
      await Bun.sleep(200);
      expect(calls).toBeGreaterThan(1);
      expect(ada.ended).toBe(false);
      expect(ada.events.some((e) => e.event === "expired")).toBe(false);
      fail = false;
      await ada.close();
    } finally {
      w.kit.intake.keyOf = real;
      streamTiming.recheckMs = before;
    }
  });

  test("a fourth open stream of one reporter is refused", async () => {
    const w = await world();
    await w.file("ada");
    const open = [];
    for (let i = 0; i < 3; i += 1) {
      const stream = await w.stream("ada");
      expect(stream.response.status).toBe(200);
      open.push(stream);
    }
    const fourth = await w.stream("ada");
    expect(fourth.response.status).toBe(429);
    await fourth.close();
    await open[0]?.close();
    await Bun.sleep(50);
    const again = await w.stream("ada");
    expect(again.response.status).toBe(200);
    await again.close();
    for (const stream of open) await stream.close();
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

describe("the live stream's unread ledger", () => {
  test("recounts the changed request only and keeps the total", async () => {
    const w = await world();
    const ids = [await w.file("ada"), await w.file("ada"), await w.file("ada")];
    const issues = [];
    for (const id of ids) issues.push(await w.accept(id));
    const comment = (issueId: string) =>
      w.kit.asOwner.call(AddComment, {
        issueId,
        input: { body: "Looking", public: true },
      });
    await comment(issues[0] as string);
    await comment(issues[0] as string);
    await comment(issues[1] as string);
    const first = await w.mongo.db.clientReports.findFirst({
      _id: new ObjectId(ids[0]),
    });
    if (!first) throw new Error("report missing");
    const session = {
      mongo: w.mongo,
      reporter: { keyId: first.widgetKeyId, reporterKey: first.reporterKey },
    } as unknown as Session;

    const seen: number[] = [];
    const raw = w.mongo.db.comments.raw;
    const aggregate = raw.aggregate.bind(raw);
    raw.aggregate = ((
      pipeline: { $match?: { issueId?: { $in: unknown[] } } }[],
    ) => {
      seen.push(pipeline[0]?.$match?.issueId?.$in.length ?? 0);
      return aggregate(pipeline as never);
    }) as typeof raw.aggregate;
    try {
      const ledger = await openLedger(session);
      expect(ledger.total()).toBe(3);
      expect(seen).toEqual([3]);

      await comment(issues[2] as string);
      seen.length = 0;
      const changed = await ledger.update(ids[2] as string);
      expect(changed).toMatchObject({
        update: { id: ids[2], unread: 1 },
        total: 4,
      });
      expect(seen).toEqual([1]);
      expect(await ledger.update("0".repeat(24))).toBeNull();
      expect(await ledger.update("not-an-id")).toBeNull();
      expect(ledger.total()).toBe(4);
    } finally {
      raw.aggregate = aggregate;
    }
  });
});

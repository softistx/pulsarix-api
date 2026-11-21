import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOfBody, goodReport, intakeKit } from "~/intake";
import { AddComment, world } from "~/requests";
import { IDENTITY_HEADER } from "./identity.service";
import { eraseMyData } from "./requests-actions.service";

// A17: the public request endpoints and the live stream (plan §19).

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

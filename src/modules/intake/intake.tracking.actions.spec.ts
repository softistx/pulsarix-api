import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { ObjectId } from "mongodb";
import { codeOfBody, goodReport, intakeKit, TICKET_SECRET } from "~/intake";
import { png, startMediaS3 } from "~/media";
import { clientHeader } from "../../http/csrf";
import { TRACKING_HEADER } from "./intake.http";
import { readTicket, TICKET_HEADER } from "./intake.tickets";

// A18: the tracking page's actions for the UI server (plan §19).

let s3: TestS3;
let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
const shot = png(64, 48);
const DAY = 86_400_000;

type Body = {
  data?: Record<string, unknown> | null;
  errors?: { extensions?: Record<string, unknown> }[];
} | null;

async function world() {
  const kit = await intakeKit({ media });
  let n = 0;
  const clearIp = () =>
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  // A report with an e-mail: its tracking token and its id.
  const report = async (extra: Record<string, unknown> = {}) => {
    clearIp();
    n += 1;
    const email = `reporter${n}@example.com`;
    const { body } = await kit.submit(goodReport({ email, ...extra }));
    const sent = (body as Body)?.data?.["submitClientReport"] as {
      reportId: string;
      files: { slot: string; ticket: string }[];
    };
    await kit.intake.settled();
    const mail = kit.mailer.sent.at(-1);
    const token = mail?.text.match(/\/track\/(\S+)/)?.[1] ?? "";
    return { id: sent.reportId, token, files: sent.files };
  };
  // An operation as the UI server makes it: no Origin, the client header, the
  // tracking token in its header.
  const ui = async (
    id: string,
    token: string | null,
    variables: Record<string, unknown> = {},
    headers: Record<string, string | null> = {},
  ) => {
    const { response, body } = await kit.op(id, variables, {
      origin: null,
      [clientHeader]: "pulsarix-ui",
      ...(token !== null && { [TRACKING_HEADER]: token }),
      ...headers,
    });
    return { status: response.status, body: body as Body };
  };
  const status = async (token: string) => {
    const { status: code, body } = await ui("clientReportStatus", token);
    expect(code).toBe(200);
    return body?.data?.["clientReportStatus"] as Record<string, unknown>;
  };
  const accept = async (reportId: string) => {
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: reportId });
    return acceptClientReport.issueId;
  };
  const mongo = await import("../../config/db").then(
    async (m) =>
      (await m.tenancy.databaseOf(kit.organisation.id)) as never as {
        db: {
          clientReports: {
            findById: (id: ObjectId) => Promise<Record<string, unknown> | null>;
            update: (id: ObjectId, patch: object) => Promise<unknown>;
          };
        };
      },
  );
  return { kit, report, ui, status, accept, mongo };
}

const OPS: [string, Record<string, unknown>][] = [
  ["clientReportStatus", {}],
  ["trackingReply", { input: { body: "hello" } }],
  ["trackingResolve", {}],
  ["trackingReopen", {}],
  ["trackingErase", {}],
  ["trackingEmails", { on: false }],
];

describe("who may act", () => {
  test("every tracking operation is refused with an Origin or without the client header", async () => {
    const w = await world();
    const { token } = await w.report();
    for (const [id, variables] of OPS) {
      const withOrigin = await w.ui(id, token, variables, {
        origin: w.kit.site,
      });
      expect(withOrigin.status).toBe(403);
      expect(codeOfBody(withOrigin.body)).toBe(
        "intake.errors.origin-not-allowed",
      );
      const bare = await w.ui(id, token, variables, { [clientHeader]: null });
      expect(bare.status).toBe(403);
    }
    // Nothing happened to the report.
    expect((await w.status(token))["emailsOn"]).toBe(true);
  });

  test("a missing, forged or foreign token is the one 404", async () => {
    const w = await world();
    const a = await w.report();
    const missing = await w.ui("trackingResolve", null);
    const forged = await w.ui(
      "trackingResolve",
      `${"0".repeat(24)}.${"A".repeat(43)}`,
    );
    const garbage = await w.ui("trackingResolve", "nope");
    for (const answer of [missing, forged, garbage]) {
      expect(answer.status).toBe(404);
      expect(codeOfBody(answer.body)).toBe("intake.errors.not-found");
    }
    expect((await w.status(a.token))["id"]).toBe(a.id);
  });

  test("the token in the variable still opens the read", async () => {
    const w = await world();
    const { token, id } = await w.report();
    const { response, body } = await w.kit.track(token);
    expect(response.status).toBe(200);
    expect(body?.data?.["clientReportStatus"]).toMatchObject({ id });
  });
});

describe("the read", () => {
  test("gives the thread, impact, type and what the reporter may do", async () => {
    const w = await world();
    const { token, id } = await w.report({ impact: "blocking", type: "bug" });
    expect(await w.status(token)).toMatchObject({
      id,
      impact: "blocking",
      type: "bug",
      thread: [],
      canReply: true,
      canReopen: false,
      resolvedAt: null,
      emailsOn: true,
      publicState: "received",
    });
  });
});

describe("reply, resolve and reopen", () => {
  test("a reply lands in the thread, with tickets only the UI server may use", async () => {
    const w = await world();
    const { token } = await w.report({
      files: [
        {
          role: "screenshot",
          name: "a.png",
          type: "image/png",
          size: shot.length,
        },
      ],
    });
    const sent = await w.ui("trackingReply", token, {
      input: {
        body: "More detail",
        files: [
          { role: "file", name: "b.png", type: "image/png", size: shot.length },
        ],
      },
    });
    expect(sent.status).toBe(200);
    const reply = sent.body?.data?.["trackingReply"] as unknown as {
      messageId: string;
      files: { slot: string; ticket: string }[];
    };
    const ticket = reply.files[0];
    expect(ticket).toBeDefined();
    if (!ticket) return;
    expect(readTicket(TICKET_SECRET, ticket.ticket)?.tracking).toBe(true);
    const put = (headers: Record<string, string>) =>
      w.kit.kit.app.fetch(
        new Request(
          `https://api.pulsarix.test/public/media/report-files/${ticket.slot}`,
          {
            method: "PUT",
            headers: {
              "content-type": "image/png",
              "content-length": String(shot.length),
              [TICKET_HEADER]: ticket.ticket,
              ...headers,
            },
            body: shot as unknown as BodyInit,
            duplex: "half",
          } as RequestInit,
        ),
      );
    expect((await put({ origin: w.kit.site })).status).toBe(403);
    expect((await put({})).status).toBe(403);
    expect((await put({ [clientHeader]: "pulsarix-ui" })).status).toBe(200);
    const read = await w.status(token);
    const thread = read["thread"] as {
      from: string;
      body: string;
      files: { name: string; thumbnailUrl: string | null }[];
    }[];
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ from: "reporter", body: "More detail" });
    expect(thread[0]?.files[0]?.thumbnailUrl).toMatch(
      /^\/public\/tracking\/files\//,
    );
  });

  test("a declined request refuses reply, resolve and reopen", async () => {
    const w = await world();
    const { token, id } = await w.report();
    await w.kit.asOwner.call(Decline, { id, reason: "Not for us" });
    for (const [op, variables] of [
      ["trackingReply", { input: { body: "please" } }],
      ["trackingResolve", {}],
      ["trackingReopen", {}],
    ] as const) {
      const answer = await w.ui(op, token, variables);
      expect(answer.status).toBe(409);
    }
    expect(await w.status(token)).toMatchObject({
      publicState: "declined",
      canReply: false,
    });
  });

  test("resolve closes it for the reporter, reopen puts it back within 30 days and not after", async () => {
    const w = await world();
    const { token, id } = await w.report();
    await w.accept(id);
    const resolved = await w.ui("trackingResolve", token);
    expect(resolved.body?.data?.["trackingResolve"]).toMatchObject({
      id,
      publicState: "resolved",
    });
    expect(await w.status(token)).toMatchObject({
      publicState: "resolved",
      canReopen: true,
    });
    const reopened = await w.ui("trackingReopen", token);
    expect(reopened.body?.data?.["trackingReopen"]).toMatchObject({
      publicState: "inProgress",
    });
    const old = await w.report();
    await w.accept(old.id);
    await w.ui("trackingResolve", old.token);
    await w.mongo.db.clientReports.update(new ObjectId(old.id), {
      resolvedByReporterAt: new Date(Date.now() - 31 * DAY),
    });
    const late = await w.ui("trackingReopen", old.token);
    expect(late.status).toBe(409);
    expect(codeOfBody(late.body)).toBe("intake.errors.reopen-expired");
  });
});

describe("e-mails and erasure", () => {
  test("the e-mail switch is for this request", async () => {
    const w = await world();
    const a = await w.report();
    const b = await w.report();
    const off = await w.ui("trackingEmails", a.token, { on: false });
    expect(off.body?.data?.["trackingEmails"]).toBe(false);
    expect((await w.status(a.token))["emailsOn"]).toBe(false);
    expect((await w.status(b.token))["emailsOn"]).toBe(true);
  });

  test("erase removes the data, the token is unknown after, and once an hour", async () => {
    const w = await world();
    const { token, id } = await w.report();
    await w.ui("trackingReply", token, { input: { body: "my private note" } });
    const erased = await w.ui("trackingErase", token);
    expect(erased.body?.data?.["trackingErase"]).toEqual({ requests: 1 });
    const stored = await w.mongo.db.clientReports.findById(new ObjectId(id));
    expect(stored).toMatchObject({
      email: null,
      trackingTokenHash: null,
    });
    expect(stored?.["erasedAt"]).toBeInstanceOf(Date);
    for (const op of [
      "clientReportStatus",
      "trackingResolve",
      "trackingErase",
    ]) {
      const answer = await w.ui(op, token);
      expect(answer.status).toBe(404);
      expect(codeOfBody(answer.body)).toBe("intake.errors.not-found");
    }
  });
});

describe("trackingErase when the erasure fails", () => {
  test("does not spend the hour: a retry erases", async () => {
    const w = await world();
    const { token, id } = await w.report();
    const real = w.kit.intake.databaseOf.bind(w.kit.intake);
    let armed = true;
    w.kit.intake.databaseOf = (async (key: Parameters<typeof real>[0]) => {
      const mongo = await real(key);
      return new Proxy(mongo, {
        get(target, property) {
          if (property === "as" && armed) {
            armed = false;
            return () => {
              throw new Error("database down");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof real;
    try {
      const failed = await w.ui("trackingErase", token);
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      w.kit.intake.databaseOf = real;
    }
    const retry = await w.ui("trackingErase", token);
    expect(retry.body?.data?.["trackingErase"]).toEqual({ requests: 1 });
    expect(
      (await w.mongo.db.clientReports.findById(new ObjectId(id)))?.["erasedAt"],
    ).toBeInstanceOf(Date);
  });
});

describe("rate limits and foreign ids", () => {
  test("actions share the tracking read limit of the address", async () => {
    const w = await world();
    const { token } = await w.report();
    let last = 200;
    for (let i = 0; i < 31 && last === 200; i += 1) {
      last = (await w.ui("trackingEmails", token, { on: true })).status;
    }
    expect(last).toBe(429);
  });

  test("a thumbnail of another report's file is the same 404 as a missing one", async () => {
    const w = await world();
    const a = await w.report();
    const b = await w.report({
      files: [
        {
          role: "screenshot",
          name: "a.png",
          type: "image/png",
          size: shot.length,
        },
      ],
    });
    const foreign = b.files[0]?.slot ?? "";
    const get = (token: string, file: string) =>
      w.kit.kit.app.fetch(
        new Request(`https://api.pulsarix.test/public/tracking/files/${file}`, {
          headers: { [TRACKING_HEADER]: token, [clientHeader]: "pulsarix-ui" },
        }),
      );
    const [asForeign, asMissing] = await Promise.all([
      get(a.token, foreign),
      get(a.token, "0".repeat(24)),
    ]);
    expect(asForeign.status).toBe(404);
    expect(await asForeign.text()).toBe(await asMissing.text());
  });
});

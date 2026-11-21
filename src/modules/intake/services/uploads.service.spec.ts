import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { ObjectId } from "mongodb";
import {
  asPreV2Key,
  codeOfBody,
  goodReport,
  type IntakeKit,
  intakeKit,
  TICKET_SECRET,
} from "~/intake";
import {
  bucketKeys,
  errorOf,
  jpegWithGps,
  onePagePdf,
  png,
  startMediaS3,
} from "~/media";
import { tenancy } from "../../../config/db";
import { signTicket, TICKET_HEADER } from "../utils/tickets.utils";
import { QUARANTINE_BYTES, ReportUploads } from "./uploads.service";

// The PUT route of the report files (A12), over a real S3 API: a ticket from
// `submitClientReport`, the raw file as the body, and the quarantine behind it.
let s3: TestS3;
let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

interface Ticket {
  slot: string;
  role: string;
  ticket: string;
  expiresAt: string;
}
const shot = png(64, 48);
const declared = (
  bytes: Uint8Array,
  role = "screenshot",
  type = "image/png",
) => ({
  role,
  name: role === "screenshot" ? "screen.png" : "notes.pdf",
  type,
  size: bytes.length,
});

const ticketsOf = (sent: {
  body: { data?: Record<string, unknown> | null } | null;
}) => {
  const data = sent.body?.data ?? {};
  return (data["submitClientReport"] as { files: Ticket[] }).files;
};
const kitWithMedia = () => intakeKit({ media });
// A report with `bytes` declared, its tickets.
async function report(kit: IntakeKit, bytes: Uint8Array = shot, extra = {}) {
  const sent = await kit.submit(
    goodReport({ files: [declared(bytes)], ...extra }),
  );
  return { sent, ticket: ticketsOf(sent)[0] as Ticket };
}

const put = (
  slot: string,
  ticket: string | null,
  bytes: Uint8Array | ReadableStream<Uint8Array>,
  options: {
    origin?: string | null;
    type?: string;
    length?: number | null;
  } & { site: string },
) => {
  const length =
    options.length === undefined
      ? bytes instanceof Uint8Array
        ? bytes.length
        : null
      : options.length;
  return (kit: IntakeKit) =>
    kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": options.type ?? "image/png",
            ...(length !== null && { "content-length": String(length) }),
            ...(ticket && { [TICKET_HEADER]: ticket }),
            ...(options.origin !== null && {
              origin: options.origin ?? options.site,
            }),
          },
          body: bytes as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
};
const send = (
  kit: IntakeKit,
  ticket: Ticket,
  bytes: Uint8Array = shot,
  options: Partial<Parameters<typeof put>[3]> = {},
) =>
  put(ticket.slot, ticket.ticket, bytes, { site: kit.site, ...options })(kit);

const slots = async (kit: IntakeKit) => {
  const mongo = await tenancy.databaseOf(kit.organisation.id);
  return (
    mongo as never as {
      db: {
        clientReportFiles: {
          findMany: (q: object) => Promise<Record<string, unknown>[]>;
          raw: { insertOne: (doc: object) => Promise<unknown> };
        };
      };
    }
  ).db.clientReportFiles;
};
const held = (kit: IntakeKit) =>
  bucketKeys(s3, `organisations/${kit.organisation.id}/`);
const claimsOf = (ticket: Ticket) =>
  JSON.parse(
    Buffer.from(ticket.ticket.split(".")[0] as string, "base64url").toString(),
  ) as Record<string, unknown>;

describe("a report with files hands out one ticket per file", () => {
  test("the response names a slot, a ticket and a deadline for each file", async () => {
    const kit = await kitWithMedia();
    const { sent, ticket } = await report(kit);
    expect(sent.response.status).toBe(200);
    expect(ticket.role).toBe("screenshot");
    expect(ticket.slot).toMatch(/^[0-9a-f]{24}$/);
    expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await slots(kit)).findMany({})).resolves.toHaveLength(1);
  });

  test("a fifth file, two screenshots, a foreign type or a PDF screenshot is refused before the report exists", async () => {
    const file = (_n: number) => declared(shot, "file", "image/png");
    // A kit each: five reports of one address in ten minutes are the limit.
    const refuse = async (files: object[], code: string) => {
      const kit = await kitWithMedia();
      const { response, body } = await kit.submit(goodReport({ files }));
      expect(await (await slots(kit)).findMany({})).toHaveLength(0);
      expect(codeOfBody(body)).toBe(code);
      expect(response.status).toBeGreaterThanOrEqual(400);
    };
    await refuse(
      [file(1), file(2), file(3), file(4), file(5)],
      "intake.errors.too-many-files",
    );
    await refuse(
      [declared(shot), declared(shot)],
      "intake.errors.too-many-files",
    );
    await refuse(
      [declared(shot, "file", "image/gif")],
      "intake.errors.file-unsupported-type",
    );
    await refuse(
      [
        {
          role: "screenshot",
          name: "s.pdf",
          type: "application/pdf",
          size: 100,
        },
      ],
      "intake.errors.file-unsupported-type",
    );
    await refuse(
      [
        {
          role: "file",
          name: "big.pdf",
          type: "application/pdf",
          size: 6 * 1024 * 1024,
        },
      ],
      "intake.errors.file-too-large",
    );
    await refuse(
      [1, 2, 3]
        .map(() => ({
          role: "file",
          name: "a.pdf",
          type: "application/pdf",
          size: 4_900_000,
        }))
        .concat([
          {
            role: "screenshot",
            name: "s.png",
            type: "image/png",
            size: 4_900_000,
          },
        ]),
      "intake.errors.files-too-large",
    );
  });

  test("a key with files off refuses them, and the widget config says so", async () => {
    const kit = await kitWithMedia();
    expect((await kit.config()).body?.data?.["widgetConfig"]).toMatchObject({
      attachments: true,
    });
    const off = await kit.asOwner.call(
      `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { id } }`,
      { id: kit.key.id, input: { attachmentsEnabled: false } },
    );
    expect(off).toBeTruthy();
    expect((await kit.config()).body?.data?.["widgetConfig"]).toMatchObject({
      attachments: false,
    });
    const { body } = await kit.submit(goodReport({ files: [declared(shot)] }));
    expect(codeOfBody(body)).toBe("intake.errors.attachments-disabled");
    expect((await kit.submit(goodReport())).response.status).toBe(200);
  });
});

describe("the PUT route", () => {
  test("a ticket stores the file in quarantine, and a replay is a 409", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const response = await send(kit, ticket);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slot: ticket.slot,
      state: "received",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "quarantined", width: 64, height: 48 });
    expect((await held(kit)).length).toBeGreaterThan(0);
    const again = await send(kit, ticket);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).extensions["code"]).toBe(
      "intake.errors.ticket-used",
    );
  });

  test("a foreign or missing Origin is a 403 with no CORS header, and nothing is stored", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const before = await held(kit);
    for (const origin of ["https://evil.test", null]) {
      const response = await send(kit, ticket, shot, { origin });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).extensions["code"]).toBe(
        "intake.errors.origin-not-allowed",
      );
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(await held(kit)).toEqual(before);
    // The preflight answers the key's own origin only.
    const preflight = (origin: string) =>
      kit.kit.app.fetch(
        new Request(
          `https://api.pulsarix.test/public/media/report-files/${ticket.slot}`,
          {
            method: "OPTIONS",
            headers: { origin, "access-control-request-method": "PUT" },
          },
        ),
      );
    const ok = await preflight(kit.site);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toContain(
      TICKET_HEADER,
    );
    expect((await preflight("https://evil.test")).status).toBe(403);
  });

  test("a forged, missing, swapped or expired ticket is refused", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const other = (await report(kit)).ticket;
    const code = async (response: Response) =>
      (await errorOf(response)).extensions["code"];
    // Forged: a payload nobody signed, another secret, a flipped signature.
    const claims = claimsOf(ticket) as never;
    const forged = signTicket("f".repeat(40), claims);
    for (const bad of [null, "garbage", forged, `${ticket.ticket}x`]) {
      const response = await send(kit, { ...ticket, ticket: bad as string });
      expect(response.status).toBe(403);
      expect(await code(response)).toBe("intake.errors.ticket-invalid");
    }
    // Swapped: another slot's ticket on this slot's URL.
    const swapped = await send(kit, { ...ticket, ticket: other.ticket });
    expect(swapped.status).toBe(403);
    expect(await code(swapped)).toBe("intake.errors.ticket-invalid");
    // Expired: a genuine signature, a deadline in the past.
    const old = signTicket(TICKET_SECRET, {
      ...(claims as object),
      expiresAt: Date.now() - 1_000,
    } as never);
    const expired = await send(kit, { ...ticket, ticket: old });
    expect(expired.status).toBe(410);
    expect(await code(expired)).toBe("intake.errors.ticket-expired");
    expect(await held(kit)).toEqual([]);
  });

  test("a type or a length other than the ticket's is a 400, a longer one a 413", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const mismatch = async (response: Response) => {
      expect(response.status).toBe(400);
      expect((await errorOf(response)).extensions["code"]).toBe(
        "intake.errors.upload-mismatch",
      );
    };
    await mismatch(await send(kit, ticket, shot, { type: "image/jpeg" }));
    await mismatch(await send(kit, ticket, shot, { length: shot.length - 1 }));
    await mismatch(await send(kit, ticket, shot, { length: null }));
    const longer = await send(kit, ticket, shot, { length: shot.length + 10 });
    expect(longer.status).toBe(413);
    // The slot is still free for the right file.
    expect((await send(kit, ticket)).status).toBe(200);
  });

  test("a file larger than its limit is a 413 before the body is read", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await send(kit, ticket, body as never, {
      length: 6 * 1024 * 1024,
    });
    expect(response.status).toBe(413);
    expect(pulled).toBe(0);
    expect(await held(kit)).toEqual([]);
  });

  test("bytes that are not the declared type are a 415 and the slot stays free", async () => {
    const kit = await kitWithMedia();
    const text = new TextEncoder().encode("<html>hello</html>");
    const sent = await kit.submit(
      goodReport({ files: [declared(text, "file", "image/png")] }),
    );
    const [ticket] = ticketsOf(sent);
    const response = await send(kit, ticket as Ticket, text);
    expect(response.status).toBe(415);
    expect(await held(kit)).toEqual([]);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "pending", claimedAt: null });
  });

  test("a PDF and a JPEG are stored as what they are", async () => {
    const kit = await kitWithMedia();
    const pdf = onePagePdf();
    const jpeg = await jpegWithGps();
    const sent = await kit.submit(
      goodReport({
        files: [
          {
            role: "file",
            name: "a.pdf",
            type: "application/pdf",
            size: pdf.length,
          },
          {
            role: "screenshot",
            name: "b.jpg",
            type: "image/jpeg",
            size: jpeg.length,
          },
        ],
      }),
    );
    const tickets = ticketsOf(sent);
    expect(
      (await send(kit, tickets[0] as Ticket, pdf, { type: "application/pdf" }))
        .status,
    ).toBe(200);
    expect(
      (await send(kit, tickets[1] as Ticket, jpeg, { type: "image/jpeg" }))
        .status,
    ).toBe(200);
    expect(
      (await (await slots(kit)).findMany({})).every(
        (f) => f["state"] === "quarantined",
      ),
    ).toBe(true);
  });

  test("the organisation's quarantine is full: 403", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await (await slots(kit)).raw.insertOne({
      _id: new ObjectId(),
      reportId: new ObjectId(),
      role: "file",
      fileName: "big.pdf",
      mime: "application/pdf",
      size: 600 * 1024 * 1024,
      state: "quarantined",
      storageKey: crypto.randomUUID(),
      previewKey: null,
      width: null,
      height: null,
      expiresAt: null,
      claimedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await send(kit, ticket);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.quarantine-full",
    );
  });

  const filler = async (kit: IntakeKit, size: number) =>
    (await slots(kit)).raw.insertOne({
      _id: new ObjectId(),
      reportId: new ObjectId(),
      role: "file",
      fileName: "held.pdf",
      mime: "application/pdf",
      size,
      state: "quarantined",
      storageKey: crypto.randomUUID(),
      previewKey: null,
      width: null,
      height: null,
      expiresAt: null,
      claimedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  test("a file that exactly fits the quarantine is accepted, one byte more is not", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await filler(kit, QUARANTINE_BYTES - shot.length);
    expect((await send(kit, ticket)).status).toBe(200);

    const over = await kitWithMedia();
    const second = await report(over);
    await filler(over, QUARANTINE_BYTES - shot.length + 1);
    const response = await send(over, second.ticket);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.quarantine-full",
    );
  });

  test("a key stored before v2 (no file fields) takes files: submit and PUT", async () => {
    const kit = await kitWithMedia();
    await asPreV2Key(kit);
    const { ticket } = await report(kit);
    expect((await send(kit, ticket)).status).toBe(200);
  });

  test("a toggle turned off after submit refuses the PUT", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await kit.asOwner.call(
      `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { id } }`,
      { id: kit.key.id, input: { attachmentsEnabled: false } },
    );
    const response = await send(kit, ticket);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.attachments-disabled",
    );
    expect(await held(kit)).toEqual([]);
  });

  test("the byte limit of an address is a 429 with a wait", async () => {
    const kit = await kitWithMedia();
    // 36 MiB per ten minutes: each ticket of 4.9 MB costs ~4785 KiB.
    const big = new Uint8Array(4_900_000);
    big.set(shot);
    const files = [1, 2].map((n) => ({
      role: "file",
      name: `n${n}.pdf`,
      type: "application/pdf",
      size: 4_900_000,
    }));
    const tickets: Ticket[] = [];
    for (let i = 0; i < 4; i += 1) {
      const sent = await kit.submit(goodReport({ files }));
      tickets.push(...ticketsOf(sent));
    }
    let refused: Response | undefined;
    for (const ticket of tickets) {
      const response = await send(kit, ticket, big, {
        type: "application/pdf",
      });
      if (response.status === 429) {
        refused = response;
        break;
      }
      await response.arrayBuffer();
    }
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("without a Redis the route is a 503, and without a file store too", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    (kit.intake.deps as { limits: unknown }).limits = undefined;
    const response = await send(kit, ticket);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.unavailable",
    );
    const bare = await intakeKit();
    const { ticket: other } = await report(bare);
    const noStore = await send(bare, other);
    expect(noStore.status).toBe(503);
  });

  test("a bot's ticket is a decoy: it looks accepted and stores nothing", async () => {
    const kit = await kitWithMedia();
    const { sent, ticket } = await report(kit, shot, {
      website: "http://spam.test",
    });
    expect(sent.response.status).toBe(200);
    expect(claimsOf(ticket)["decoy"]).toBe(true);
    const response = await send(kit, ticket);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slot: ticket.slot,
      state: "received",
    });
    expect(await held(kit)).toEqual([]);
    expect(await (await slots(kit)).findMany({})).toHaveLength(0);
  });
});

const waitFor = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("the PUT route, hard cases (A12 follow-ups)", () => {
  test("a second PUT while the first holds the slot is a 409, and the first still lands", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    let finish = () => {};
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(shot);
          controller.close();
        };
      },
    });
    const first = send(kit, ticket, slow as never, { length: shot.length });
    await waitFor(
      async () =>
        (await (await slots(kit)).findMany({})).some(
          (file) => file["claimedAt"] instanceof Date,
        ),
      "the first upload to take the slot",
    );
    const second = await send(kit, ticket);
    expect(second.status).toBe(409);
    expect((await errorOf(second)).extensions["code"]).toBe(
      "intake.errors.ticket-used",
    );
    finish();
    const landed = await first;
    expect(landed.status).toBe(200);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "quarantined", claimedAt: null });
  });

  test("a key revoked after the submit refuses the PUT, and nothing is stored", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await kit.asOwner.call(`mutation($id: ID!) { revokeWidgetKey(id: $id) }`, {
      id: kit.key.id,
    });
    const response = await send(kit, ticket);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.unknown-key",
    );
    expect(await held(kit)).toEqual([]);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "pending", claimedAt: null });
  });

  test("a body that is not the declared Content-Length is refused, nothing is stored, and the slot is free again", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const longer = new Uint8Array(shot.length + 64);
    longer.set(shot);
    const shorter = shot.slice(0, shot.length - 10);
    for (const body of [longer, shorter]) {
      const response = await send(kit, ticket, body, { length: shot.length });
      expect(response.status).not.toBe(200);
      expect(await held(kit)).toEqual([]);
      const [file] = await (await slots(kit)).findMany({});
      expect(file).toMatchObject({ state: "pending", claimedAt: null });
    }
    // The right file still goes through.
    expect((await send(kit, ticket)).status).toBe(200);
  });
});

describe("a decoy ticket answers like a real one", () => {
  const decoy = async (kit: IntakeKit) => {
    const { sent, ticket } = await report(kit, shot, {
      website: "http://spam.test",
    });
    expect(sent.response.status).toBe(200);
    return ticket;
  };

  test("a replay is a 409 ticket-used, as a real replay is, and nothing is stored", async () => {
    const kit = await kitWithMedia();
    const ticket = await decoy(kit);
    expect((await send(kit, ticket)).status).toBe(200);
    const again = await send(kit, ticket);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).extensions["code"]).toBe(
      "intake.errors.ticket-used",
    );
    expect(await held(kit)).toEqual([]);
    expect(await (await slots(kit)).findMany({})).toHaveLength(0);
    // Another decoy ticket is not held back by it.
    expect((await send(kit, await decoy(kit))).status).toBe(200);
  });

  test("an expired decoy ticket is a 410, a foreign Origin a 403 with no CORS header", async () => {
    const kit = await kitWithMedia();
    const ticket = await decoy(kit);
    const old = signTicket(TICKET_SECRET, {
      ...claimsOf(ticket),
      expiresAt: Date.now() - 1_000,
    } as never);
    const expired = await send(kit, { ...ticket, ticket: old });
    expect(expired.status).toBe(410);
    expect((await errorOf(expired)).extensions["code"]).toBe(
      "intake.errors.ticket-expired",
    );
    const foreign = await send(kit, ticket, shot, {
      origin: "https://evil.test",
    });
    expect(foreign.status).toBe(403);
    expect((await errorOf(foreign)).extensions["code"]).toBe(
      "intake.errors.origin-not-allowed",
    );
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    // The refusals did not use the ticket up.
    expect((await send(kit, ticket)).status).toBe(200);
  });

  test("a decoy ticket with the wrong type or length is a 400 like a real one", async () => {
    const kit = await kitWithMedia();
    const ticket = await decoy(kit);
    const wrong = await send(kit, ticket, shot, { type: "image/jpeg" });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).extensions["code"]).toBe(
      "intake.errors.upload-mismatch",
    );
  });
});

describe("the organisation's quarantine, counted from an index", () => {
  test("the byte sum reads the state and size index, never the collection", async () => {
    const kit = await kitWithMedia();
    await report(kit);
    const files = await slots(kit);
    const plan = (await (
      files as unknown as {
        raw: {
          aggregate: (p: object[]) => {
            explain: (v: string) => Promise<unknown>;
          };
        };
      }
    ).raw
      .aggregate([
        { $match: { state: { $in: ["pending", "quarantined"] } } },
        { $group: { _id: null, bytes: { $sum: "$size" } } },
      ])
      .explain("queryPlanner")) as object;
    const text = JSON.stringify(plan);
    expect(text).toContain("clientReportFiles_stateSize");
    expect(text).not.toContain('"COLLSCAN"');
  });
});

describe("a file stored while its report is being accepted", () => {
  test("a stale read of the report does not leave the file quarantined", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const claims = claimsOf(ticket);
    await kit.asOwner.call(
      `mutation($id: ID!) { acceptClientReport(id: $id) { id } }`,
      { id: claims["reportId"] },
    );
    const real = (await tenancy.databaseOf(kit.organisation.id)) as never as {
      db: {
        clientReports: {
          findById: (id: ObjectId) => Promise<unknown>;
        };
      };
    };
    // The first read of the report (before the write) still sees it as new.
    let reads = 0;
    const db = new Proxy(real.db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "clientReports") return value;
        return new Proxy(value as object, {
          get(inner, name, innerReceiver) {
            if (name !== "findById")
              return Reflect.get(inner, name, innerReceiver);
            return async (id: ObjectId) => {
              const found = (await (
                inner as typeof real.db.clientReports
              ).findById(id)) as object;
              reads += 1;
              return reads === 1 ? { ...found, state: "new" } : found;
            };
          },
        });
      },
    });
    const uploads = new ReportUploads(kit.intake as never);
    await uploads.store(
      {
        claims: claims as never,
        decoy: false,
        mongo: new Proxy(real, {
          get: (target, key, receiver) =>
            key === "db" ? db : Reflect.get(target, key, receiver),
        }) as never,
        projectId: String(claims["projectId"] ?? ""),
        role: "screenshot",
      },
      { key: crypto.randomUUID(), contentType: "image/png", sizes: [] },
      undefined,
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "released", expiresAt: null });
  });
});

describe("a file stored after its issue was deleted", () => {
  test("carries a removal date, so the retention job purges it", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const claims = claimsOf(ticket);
    const accepted = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(`mutation($id: ID!) { acceptClientReport(id: $id) { issueId } }`, {
      id: claims["reportId"],
    });
    await kit.asOwner.call(`mutation($id: ID!) { deleteIssue(id: $id) }`, {
      id: accepted.acceptClientReport.issueId,
    });
    expect((await send(kit, ticket)).status).toBe(200);
    const [file] = await (await slots(kit)).findMany({});
    expect(file?.["state"]).toBe("released");
    expect(file?.["expiresAt"]).toBeInstanceOf(Date);
  });
});

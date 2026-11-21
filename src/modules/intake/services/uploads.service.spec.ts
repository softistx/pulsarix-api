import { describe, expect, test } from "bun:test";
import type { ObjectId } from "mongodb";
import { codeOfBody, goodReport } from "~/intake";
import {
  claimsOf,
  declared,
  kitWithMedia,
  report,
  send,
  shot,
  slots,
  useMediaS3,
} from "~/uploads";
import { tenancy } from "../../../config/db";
import { ReportUploads } from "./uploads.service";

useMediaS3();

// The PUT route of the report files (A12), over a real S3 API: a ticket from
// `submitClientReport`, the raw file as the body, and the quarantine behind it.

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

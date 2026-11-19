import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { TestS3 } from "@softistx/s3/testing";
import type { ObjectId } from "mongodb";
import { goodReport, intakeKit } from "~/intake";
import { startMediaS3 } from "~/media";
import { tenancy } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import type { Media } from "../attachments/public";
import { fileObjectKeys } from "./intake.files.storage";
import { REQUEST_FILES_PATH } from "./intake.http";
import { IDENTITY_HEADER } from "./intake.identity";
import type { IntakeMongo } from "./intake.submit";

// A17: the thumbnail route of the request thread (plan §19).

let s3: TestS3;
let media: Media;
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

async function world() {
  const kit = await intakeKit({ media });
  const secret = (
    await kit.asOwner.call<{
      generateWidgetIdentitySecret: { secret: string };
    }>(
      `mutation($keyId: ID!) { generateWidgetIdentitySecret(keyId: $keyId) { secret } }`,
      { keyId: kit.key.id },
    )
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
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const file = async (sub: string, mime = "image/png") => {
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
    const { body } = await kit.submit(goodReport({ title: `By ${sub}` }), {
      [IDENTITY_HEADER]: token(sub),
    });
    const reportId = (
      body as unknown as { data: { submitClientReport: { reportId: string } } }
    ).data.submitClientReport.reportId;
    const storageKey = crypto.randomUUID();
    for (const key of fileObjectKeys(kit.organisation.id, storageKey)) {
      await media.bucket.put({ key }, new Uint8Array([1, 2, 3]), {
        type: "image/webp",
      });
    }
    const created = await mongo.db.clientReportFiles.create({
      reportId: reportId as unknown as ObjectId,
      role: "screenshot",
      fileName: "shot",
      mime,
      size: 3,
      storageKey,
      previewKey: "256",
      width: 10,
      height: 10,
      state: "released",
      expiresAt: null,
    } as never);
    return String(created._id);
  };
  const get = (
    id: string,
    options: { sub?: string | null; origin?: string; method?: string } = {},
  ) =>
    kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test${REQUEST_FILES_PATH}/${id}?key=${encodeURIComponent(kit.key.publicKey)}`,
        {
          method: options.method ?? "GET",
          headers: {
            origin: options.origin ?? kit.site,
            ...(options.sub != null && {
              [IDENTITY_HEADER]: token(options.sub),
            }),
          },
        },
      ),
    );
  return { kit, file, get };
}

describe("the request thumbnail route", () => {
  test("serves the reporter's own thumbnail with the key's CORS", async () => {
    const { kit, file, get } = await world();
    const id = await file("alice");
    const response = await get(id, { sub: "alice" });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
  });

  test("another reporter's file, a missing one and a PDF answer the same 404", async () => {
    const { file, get } = await world();
    const id = await file("alice");
    const pdf = await file("alice", "application/pdf");
    expect((await get(id, { sub: "bob" })).status).toBe(404);
    expect((await get("0".repeat(24), { sub: "alice" })).status).toBe(404);
    expect((await get("not-an-id", { sub: "alice" })).status).toBe(404);
    expect((await get(pdf, { sub: "alice" })).status).toBe(404);
  });

  test("needs a valid token and an allowed origin", async () => {
    const { file, get } = await world();
    const id = await file("alice");
    expect((await get(id, { sub: null })).status).toBe(401);
    const foreign = await get(id, {
      sub: "alice",
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("answers HEAD, refuses other methods", async () => {
    const { file, get } = await world();
    const id = await file("alice");
    expect((await get(id, { sub: "alice", method: "POST" })).status).toBe(405);
    expect((await get(id, { sub: "bob", method: "HEAD" })).status).toBe(404);
  });
});

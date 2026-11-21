import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Attachment,
  attach,
  List,
  onePagePdf,
  read,
  s3,
  setup,
  startStore,
  stopStore,
  upload,
} from "~/attachments";
import { bucketKeys, errorOf, pdf, png } from "~/media";
import { maxBytes } from "./attachments.kinds";

beforeAll(startStore, 300_000);
afterAll(stopStore, 60_000);

describe("uploading", () => {
  test("a picture is stored with its thumbnail and listed on its issue", async () => {
    const w = await setup();
    const bytes = png(300, 200);
    const stored = await attach(w, w.member.token, "issue", w.issue.id, bytes, {
      type: "image/png",
      name: "shot.png",
    });
    expect(stored.previewKey).toBe("256");

    const { attachments } = await w
      .as(w.viewer.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments).toEqual([
      {
        id: stored.id,
        ownerType: "issue",
        ownerId: w.issue.id,
        issueId: w.issue.id,
        fileName: "shot.png",
        mime: "image/png",
        size: bytes.length,
        url: `/media/attachments/${stored.key}`,
        previewUrl: `/media/attachments/${stored.key}/256`,
        uploadedBy: w.member.id,
      },
    ]);

    const original = await read(w, w.viewer.token, attachments[0]?.url ?? "");
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    const thumb = await read(
      w,
      w.viewer.token,
      attachments[0]?.previewUrl ?? "",
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    const decoded = await new Bun.Image(await thumb.arrayBuffer()).metadata();
    expect([decoded.width, decoded.height]).toEqual([256, 256]);
  }, 60_000);

  test("a PDF gets a WebP preview of its first page, served to readers only", async () => {
    const w = await setup();
    const stored = await attach(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      onePagePdf(),
      { name: "page.pdf" },
    );
    expect(stored.previewKey).toBe("256");
    const { attachments } = await w
      .as(w.viewer.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments[0]?.previewUrl).toBe(
      `/media/attachments/${stored.key}/256`,
    );
    const preview = await read(
      w,
      w.viewer.token,
      attachments[0]?.previewUrl ?? "",
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    const decoded = await new Bun.Image(await preview.arrayBuffer()).metadata();
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.width).toBeLessThanOrEqual(256);
    expect(decoded.height).toBeLessThanOrEqual(256);
    const anonymous = await read(w, null, attachments[0]?.previewUrl ?? "");
    expect(anonymous.status).toBe(401);
  }, 60_000);

  test("a PDF that cannot be drawn is stored as it is, with no preview", async () => {
    const w = await setup();
    const stored = await attach(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      pdf(100),
      {
        name: "spec.pdf",
      },
    );
    expect(stored.previewKey).toBeNull();
    const { attachments } = await w
      .as(w.member.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments[0]).toMatchObject({
      mime: "application/pdf",
      previewUrl: null,
    });
    const file = await read(w, w.member.token, attachments[0]?.url ?? "");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    const preview = await read(w, w.member.token, `${attachments[0]?.url}/256`);
    expect(preview.status).toBe(404);
  }, 60_000);

  test("a file name is kept as its last path segment", async () => {
    const w = await setup();
    await attach(w, w.member.token, "issue", w.issue.id, pdf(), {
      name: "..\\..//etc/notes.pdf",
    });
    const { attachments } = await w
      .as(w.member.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments[0]?.fileName).toBe("notes.pdf");
  }, 60_000);

  test("a type outside the list, or bytes that are not the declared type, are refused 415", async () => {
    const w = await setup();
    const text = new TextEncoder().encode("hello");
    const plain = await upload(w, w.member.token, "issue", w.issue.id, text, {
      type: "text/plain",
    });
    expect(plain.status).toBe(415);
    expect((await errorOf(plain)).extensions["code"]).toBe(
      "attachments.errors.unsupported-type",
    );
    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    const disguised = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      html,
      {
        type: "application/pdf",
      },
    );
    expect(disguised.status).toBe(415);
    const { attachments } = await w
      .as(w.member.token)
      .call<{ attachments: Attachment[] }>(List, {
        ownerType: "issue",
        ownerId: w.issue.id,
      });
    expect(attachments).toEqual([]);
  }, 60_000);

  test("a file over the size limit is refused 413 and nothing is stored", async () => {
    const w = await setup();
    const before = await bucketKeys(s3, `organisations/${w.organisation.id}/`);
    const response = await upload(
      w,
      w.member.token,
      "issue",
      w.issue.id,
      pdf(maxBytes),
    );
    expect(response.status).toBe(413);
    const error = await errorOf(response);
    expect(error.extensions["code"]).toBe("attachments.errors.too-large");
    expect(error.extensions["params"]).toEqual({ reason: "bytes", max: 10 });
    expect(await bucketKeys(s3, `organisations/${w.organisation.id}/`)).toEqual(
      before,
    );
  }, 60_000);
});

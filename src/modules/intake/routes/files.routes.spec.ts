import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { alxia } from "@softistx/alxia";
import type { TestS3 } from "@softistx/s3/testing";
import {
  bucketKeys,
  errorOf,
  flatPng,
  gif,
  gpsMarker,
  heic,
  jpegWithGps,
  onePagePdf,
  png,
  startMediaS3,
  svg,
} from "~/media";
import type { Media } from "../../attachments/public";
import { maxFileBytes } from "../intake.files.kinds";
import { reportFilesRoutes } from "./files.routes";

// The `report-files` media kind over a real S3 API (@softistx/s3/testing). The
// route here is the kind's own, mounted with the guard a spec needs (anyone
// writes, anyone reads); A12 mounts it behind a signed ticket.
let s3: TestS3;
let media: Media;
let app: { fetch: (request: Request) => Response | Promise<Response> };
const organisationId = "64b0c0ffee0000000000a11a";

beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
  app = alxia().plugin(
    reportFilesRoutes({
      media,
      authorizeWrite: () => true,
      authorizeRead: () => true,
      organisationOf: () => organisationId,
      uploaded: ({ key, sizes, renditions }) => {
        const full = renditions.find((rendition) => rendition.size === "full");
        return { key, sizes, width: full?.width, height: full?.height };
      },
    }),
  ) as unknown as typeof app;
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const put = (bytes: Uint8Array, type: string) =>
  app.fetch(
    new Request("https://api.pulsarix.test/media/report-files", {
      method: "PUT",
      headers: { "content-type": type, "content-length": String(bytes.length) },
      body: bytes as unknown as BodyInit,
      duplex: "half",
    } as RequestInit),
  );
const stored = () => bucketKeys(s3, `organisations/${organisationId}/`);

describe("what a report may attach", () => {
  test("bytes that are not the declared type are a 415, and nothing is stored", async () => {
    const before = await stored();
    const asPng = await put(
      new TextEncoder().encode("<html>hi</html>"),
      "image/png",
    );
    expect(asPng.status).toBe(415);
    expect((await errorOf(asPng)).extensions["code"]).toBe(
      "intake.errors.file-unsupported-type",
    );
    // A JPEG sent as a PNG, a page sent as a PDF.
    expect((await put(await jpegWithGps(), "image/png")).status).toBe(415);
    expect(
      (await put(new TextEncoder().encode("<html></html>"), "application/pdf"))
        .status,
    ).toBe(415);
    expect(await stored()).toEqual(before);
  });

  test("SVG, GIF and HEIC are a 415, declared as themselves or as a picture", async () => {
    const before = await stored();
    for (const [bytes, type] of [
      [svg(), "image/svg+xml"],
      [svg(), "image/png"],
      [gif(), "image/gif"],
      [gif(), "image/webp"],
      [heic(), "image/heic"],
      [heic(), "image/jpeg"],
    ] as const) {
      const response = await put(bytes, type);
      expect({ type, status: response.status }).toEqual({ type, status: 415 });
    }
    expect(await stored()).toEqual(before);
  });

  test("no GPS data, EXIF or original reaches the bucket", async () => {
    const original = await jpegWithGps();
    const response = await put(original, "image/jpeg");
    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      key: string;
      sizes: string[];
      width: number;
      height: number;
    };
    expect(answer.sizes.sort()).toEqual(["256", "full"]);
    expect({ width: answer.width, height: answer.height }).toEqual({
      width: 320,
      height: 200,
    });
    const keys = (await stored()).filter((key) => key.includes(answer.key));
    // Renditions only: no object at the key itself.
    expect(keys.sort()).toEqual([
      `organisations/${organisationId}/report-files/${answer.key}/256`,
      `organisations/${organisationId}/report-files/${answer.key}/full`,
    ]);
    for (const size of ["full", "256"]) {
      const read = await app.fetch(
        new Request(
          `https://api.pulsarix.test/media/report-files/${answer.key}/${size}`,
        ),
      );
      expect(read.status).toBe(200);
      const bytes = new Uint8Array(await read.arrayBuffer());
      const asText = new TextDecoder("latin1").decode(bytes);
      expect(asText).not.toContain("Exif");
      expect(asText).not.toContain(gpsMarker);
      expect(asText).not.toContain("GPS");
    }
    // The original is a 404.
    const originalRead = await app.fetch(
      new Request(`https://api.pulsarix.test/media/report-files/${answer.key}`),
    );
    expect(originalRead.status).toBe(404);
  });

  test("a picture over 2560 px is made to fit, one under is never enlarged", async () => {
    const big = await put(png(2880, 1800), "image/png");
    expect(big.status).toBe(200);
    const small = await put(png(100, 60), "image/png");
    expect(small.status).toBe(200);
    expect(await big.json()).toMatchObject({ width: 2560, height: 1600 });
    expect(await small.json()).toMatchObject({ width: 100, height: 60 });
  });

  test("a picture of 26 megapixels is a 422, and nothing is stored", async () => {
    const before = await stored();
    const bytes = flatPng(6000, 4334);
    expect(bytes.length).toBeLessThan(maxFileBytes);
    const response = await put(bytes, "image/png");
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.extensions["code"]).toBe("intake.errors.file-too-many-pixels");
    expect(await stored()).toEqual(before);
  }, 60_000);

  test("an empty body and a truncated picture are refused, and nothing is stored", async () => {
    const before = await stored();
    const empty = await put(new Uint8Array(), "image/png");
    expect(empty.status).toBeGreaterThanOrEqual(400);
    const full = png(64, 64);
    const corrupt = await put(full.slice(0, 24), "image/png");
    expect(corrupt.status).toBeGreaterThanOrEqual(400);
    expect(corrupt.status).toBeLessThan(500);
    expect(await stored()).toEqual(before);
  });

  test("a file over 5 MB is a 413", async () => {
    const response = await put(
      new Uint8Array(maxFileBytes + 1),
      "application/pdf",
    );
    expect(response.status).toBe(413);
  });

  test("a PDF keeps its own bytes and a first-page preview, and no image keeps an original", async () => {
    const pdf = onePagePdf();
    const response = await put(pdf, "application/pdf");
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { key: string; sizes: string[] };
    expect(answer.sizes.sort()).toEqual(["256"]);
    const file = await app.fetch(
      new Request(`https://api.pulsarix.test/media/report-files/${answer.key}`),
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);
  });
});

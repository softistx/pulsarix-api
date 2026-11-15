import { deflateSync } from "node:zlib";
import { bindBucket, defineBucket } from "@softistx/s3";
import { startTestS3, type TestS3 } from "@softistx/s3/testing";
import { clientHeader } from "../src/http/csrf";
import {
  createMedia,
  type Media,
} from "../src/modules/attachments/attachments.storage";

// A real S3 API for a spec, started by @softistx/s3/testing (SeaweedFS on free
// ports, no Docker), with the bucket the routes write to. The first run on a
// machine downloads SeaweedFS (`$WEED_BIN` names one already there).
export const bucket = "pulsarix-media";

export async function startMediaS3(): Promise<{ s3: TestS3; media: Media }> {
  const s3 = await startTestS3();
  await s3.createBucket(bucket);
  const media = createMedia({
    bucket,
    endpoint: s3.endpoint,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  });
  return { s3, media };
}

// The keys the bucket holds under `prefix`, sorted.
export async function bucketKeys(s3: TestS3, prefix = "") {
  const view = bindBucket(
    defineBucket({ bucket, key: (p: { k: string }) => p.k }),
    s3.options,
  );
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await view.list({ prefix, cursor });
    found.push(...page.items.map((item) => item.key));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return found.sort();
}

// A request to an app, as the UI's server sends it.
export const call = (
  app: { fetch: (request: Request) => Response | Promise<Response> },
  path: string,
  init: {
    method?: string;
    token?: string | null;
    organisation?: string;
    headers?: Record<string, string>;
    body?: BodyInit | undefined;
    client?: boolean;
  } = {},
) =>
  app.fetch(
    new Request(`https://ui.pulsarix.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.client === false ? {} : { [clientHeader]: "spec" }),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.organisation
          ? { "x-organization-id": init.organisation }
          : {}),
        ...init.headers,
      },
      body: init.body ?? null,
      duplex: "half",
    } as RequestInit),
  );

// The first error of a refusal's JSON.
export const errorOf = async (response: Response) => {
  const { errors } = (await response.json()) as {
    errors: { message: string; extensions: Record<string, unknown> }[];
  };
  return errors[0] as (typeof errors)[number];
};

// Files the specs generate, so no binary file lives in the repository.
const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const text = (value: string) => new TextEncoder().encode(value);

function chunk(type: string, data: Uint8Array) {
  const body = join(text(type), data);
  return join(u32(data.length), body, u32(Bun.hash.crc32(body)));
}

// A `width` x `height` RGB PNG: a diagonal gradient.
export function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const header = join(u32(width), u32(height), new Uint8Array([8, 2, 0, 0, 0]));
  const rows = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      rows.set([(x * 255) / width, (y * 255) / height, 120], row + 1 + x * 3);
    }
  }
  return join(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  );
}

// A PDF's first bytes are all the upload check reads.
export const pdf = (extra = 0): Uint8Array<ArrayBuffer> =>
  join(text("%PDF-1.7\n%spec\n"), new Uint8Array(extra));

// A `width` x `height` RGB PNG of one flat colour: the same pixels as `png`
// claims, but it deflates to a few kilobytes, so a 26-megapixel picture fits
// under a byte limit and a spec can tell the pixel limit from the size one.
export function flatPng(
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const header = join(u32(width), u32(height), new Uint8Array([8, 2, 0, 0, 0]));
  const rows = new Uint8Array((width * 3 + 1) * height).fill(90);
  for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0;
  return join(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  );
}

// The marker the GPS spec looks for in every stored byte, in the EXIF's
// ImageDescription and its GPS IFD.
export const gpsMarker = "GPS-LEAK-MARKER-48.8584N";

// A JPEG whose EXIF (APP1) carries an ImageDescription and a GPS IFD with a
// latitude, the way a phone's camera writes one.
export async function jpegWithGps(width = 320, height = 200) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#3355aa";
  context.fillRect(0, 0, width, height);
  const jpeg = new Uint8Array(canvas.toBuffer("image/jpeg"));
  const description = `${gpsMarker}\0`;
  // TIFF (little-endian): IFD0 with 2 entries (ImageDescription, GPSInfo), then
  // the description, then the GPS IFD with 2 entries (LatitudeRef, Latitude).
  const ifd0 = 8;
  const descriptionAt = ifd0 + 2 + 2 * 12 + 4;
  const gpsAt = descriptionAt + description.length;
  const latitudeAt = gpsAt + 2 + 2 * 12 + 4;
  const tiff: number[] = [];
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const le32 = (n: number) => [
    n & 255,
    (n >> 8) & 255,
    (n >> 16) & 255,
    (n >> 24) & 255,
  ];
  tiff.push(0x49, 0x49, 0x2a, 0x00, ...le32(ifd0));
  tiff.push(...le16(2));
  tiff.push(
    ...le16(0x010e),
    ...le16(2),
    ...le32(description.length),
    ...le32(descriptionAt),
  );
  tiff.push(...le16(0x8825), ...le16(4), ...le32(1), ...le32(gpsAt));
  tiff.push(...le32(0));
  tiff.push(...text(description));
  tiff.push(...le16(2));
  tiff.push(...le16(1), ...le16(2), ...le32(2), 0x4e, 0, 0, 0);
  tiff.push(...le16(2), ...le16(5), ...le32(3), ...le32(latitudeAt));
  tiff.push(...le32(0));
  for (const [n, d] of [
    [48, 1],
    [51, 1],
    [30, 1],
  ] as const) {
    tiff.push(...le32(n), ...le32(d));
  }
  const payload = join(text("Exif\0\0"), new Uint8Array(tiff));
  const segment = join(
    new Uint8Array([0xff, 0xe1]),
    new Uint8Array([(payload.length + 2) >> 8, (payload.length + 2) & 255]),
    payload,
  );
  return join(jpeg.subarray(0, 2), segment, jpeg.subarray(2));
}

// A valid one-page PDF (offsets computed), small enough to draw in a spec.
export function onePagePdf(): Uint8Array<ArrayBuffer> {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>",
    "<< /Length 40 >>\nstream\n0.2 0.4 0.8 rg 20 20 160 260 re f\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text(out) as Uint8Array<ArrayBuffer>;
}

// First bytes of the formats a report refuses.
export const svg = (): Uint8Array<ArrayBuffer> =>
  text(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
  ) as Uint8Array<ArrayBuffer>;
export const gif = (): Uint8Array<ArrayBuffer> =>
  join(text("GIF89a"), new Uint8Array(32));
export const heic = (): Uint8Array<ArrayBuffer> =>
  join(new Uint8Array([0, 0, 0, 24]), text("ftypheic"), new Uint8Array(32));

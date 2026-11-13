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

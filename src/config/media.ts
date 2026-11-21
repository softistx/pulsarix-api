import {
  createMedia,
  type Media,
} from "../modules/attachments/attachments.store";
import { env } from "./env";

// The file store of the server, or none: the media routes answer 503
// `attachments.errors.unavailable` without it, and nothing else changes,
// /ready included. Configured when S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY
// are all set (S3_ENDPOINT and S3_REGION are optional: without an endpoint,
// Bun's client reaches AWS). Some of the three but not all is a mistake, and
// stops the process before it listens.
export function mediaFrom(values: {
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_ACCESS_KEY?: string | undefined;
  S3_SECRET_KEY?: string | undefined;
}): Media | undefined {
  const { S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = values;
  if (!S3_BUCKET && !S3_ACCESS_KEY && !S3_SECRET_KEY) return undefined;
  if (!S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    throw new Error(
      "S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY go together: set all three or none",
    );
  }
  return createMedia({
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    endpoint: values.S3_ENDPOINT,
    region: values.S3_REGION,
  });
}

export const serverMedia = mediaFrom(env);

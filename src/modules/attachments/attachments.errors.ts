import type { MediaRefusal } from "@softistx/alxia-media";
import { fail } from "../../core/shared/errors";

// The file is over the size limit: `max` is the limit in MB for the bytes
// (`reason` "bytes") and in megapixels for the pixels.
export const tooLarge = (limit: { bytes: number } | { pixels: number }) =>
  fail("attachments.errors.too-large", {
    params:
      "pixels" in limit
        ? { reason: "pixels", max: Math.round(limit.pixels / 1_000_000) }
        : { reason: "bytes", max: Math.round(limit.bytes / (1024 * 1024)) },
    status: 413,
  });

export const unsupportedType = () =>
  fail("attachments.errors.unsupported-type", { status: 415 });

export const undecodable = () =>
  fail("attachments.errors.undecodable", { status: 422 });

export const tooSmall = (min: number) =>
  fail("attachments.errors.too-small", { params: { min }, status: 422 });

// An owner already carries as many files as it may.
export const tooMany = (max: number) =>
  fail("attachments.errors.too-many", { params: { max }, status: 409 });

export const attachmentNotFound = () =>
  fail("attachments.errors.not-found", { status: 404 });

// The file store is not configured or cannot be reached: 503, so the client
// reads "later", never "refused".
export const unavailable = () =>
  fail("attachments.errors.unavailable", { status: 503 });

// A refusal of @softistx/alxia-media as the API's error, so a client reads an upload
// refusal like a GraphQL one. `undefined` for the package's transport
// refusals (`stalled`, `interrupted`, ...), which keep its own body.
export function refusalFailure(
  refusal: MediaRefusal,
  limits: { maxBytes: number; maxPixels: number },
) {
  const { details } = refusal;
  switch (refusal.code) {
    case "unauthenticated":
      return fail("auth.errors.unauthenticated", { status: 401 });
    case "forbidden":
      return fail("auth.errors.forbidden", { status: 403 });
    case "not_found":
      return attachmentNotFound();
    case "unavailable":
      return unavailable();
    case "too_large":
      return tooLarge({ bytes: limits.maxBytes });
    case "unsupported_type":
      return unsupportedType();
    case "empty_body":
      return undecodable();
    case "unprocessable":
      switch (details.reason) {
        case "dimensions":
          return tooSmall(details.min ?? 0);
        case "pixels":
          return tooLarge({ pixels: limits.maxPixels });
        default:
          return undecodable();
      }
    default:
      return undefined;
  }
}

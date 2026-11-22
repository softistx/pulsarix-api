import { GraphQLError } from "graphql";
import { fail, retryParams } from "../../core/shared/errors";
import { i18n } from "../../i18n";

// A key that is unknown, revoked, or not spelled like one: one answer for all.
export const unknownKey = () =>
  fail("intake.errors.unknown-key", { status: 404 });

// The `Origin` is missing or is not in the key's allow-list: nothing is read,
// nothing is stored.
export const originNotAllowed = () =>
  fail("intake.errors.origin-not-allowed", { status: 403 });

// The admin's switch is off: the widget does not take reports.
export const keyDisabled = () =>
  fail("intake.errors.key-disabled", { status: 403 });

// Over a rate limit: 429 with `retryAfter` (seconds) and `minutes`, in
// `extensions` and `extensions.params` as `auth.errors.too-many-attempts` has.
export function tooManyRequests(retryAfterMs: number) {
  const params = retryParams(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return new GraphQLError(i18n.t("intake.errors.too-many-requests", params), {
    extensions: {
      code: "intake.errors.too-many-requests",
      params,
      http: { status: 429 },
      ...params,
    },
  });
}

// The rate limits cannot be checked (no Redis, or it does not answer): the
// public endpoint refuses rather than open unmetered.
export const unavailable = () =>
  fail("intake.errors.unavailable", { status: 503 });

// The public endpoint runs persisted operations only, named by `id`.
export const persistedOnly = () =>
  fail("intake.errors.persisted-only", { status: 400 });

export const unsupportedMedia = () =>
  fail("intake.errors.unsupported-media", { status: 415 });

// The form was sent faster than a person can fill it.
export const tooFast = () => fail("intake.errors.too-fast", { status: 400 });

export const keyNotFound = () =>
  fail("intake.errors.key-not-found", { status: 404 });

export const reportNotFound = () =>
  fail("intake.errors.not-found", { status: 404 });

// Only a new report is accepted or declined.
export const reportDecided = () =>
  fail("intake.errors.report-decided", { status: 409 });

// 409: the report is already linked to that issue.
export const linkExists = () =>
  fail("intake.errors.link-exists", { status: 409 });

// 409: a decided report keeps at least one link; the last one cannot go.
export const lastLink = () => fail("intake.errors.last-link", { status: 409 });

// 409: the issue is in another project than the report's.
export const issueOtherProject = () =>
  fail("intake.errors.issue-other-project", { status: 409 });

// An origin of the allow-list that is not `scheme://host[:port]`.
export const invalidOrigin = (origin: string) =>
  fail("intake.errors.invalid-origin", {
    status: 400,
    field: "allowedOrigins",
    params: { origin: origin.slice(0, 100) },
  });

// The refusals of an upload to the `report-files` kind (intake.files.kinds.ts).
// 415: not a PNG, JPEG, WebP or PDF, or its first bytes say otherwise (SVG, GIF
// and HEIC included).
export const fileUnsupportedType = () =>
  fail("intake.errors.file-unsupported-type", { status: 415 });

// 422: empty, damaged, or smaller than the 16 px a picture needs.
export const fileUndecodable = () =>
  fail("intake.errors.file-undecodable", { status: 422 });

// 413: over the byte limit; `max` is in MB.
export const fileTooLarge = (maxBytes: number) =>
  fail("intake.errors.file-too-large", {
    params: { max: Math.round(maxBytes / (1024 * 1024)) },
    status: 413,
  });

// 422: the picture claims more pixels than the limit; `max` is in megapixels.
export const fileTooManyPixels = (maxPixels: number) =>
  fail("intake.errors.file-too-many-pixels", {
    params: { max: Math.round(maxPixels / 1_000_000) },
    status: 422,
  });

// The upload by ticket (plan §17, A12).
// 403: the key's "Screenshots and files" switch is off.
export const attachmentsDisabled = () =>
  fail("intake.errors.attachments-disabled", { status: 403 });

// 400: more than 1 screenshot and 3 files (`max` is the total).
export const tooManyFiles = (max: number) =>
  fail("intake.errors.too-many-files", {
    status: 400,
    field: "files",
    params: { max },
  });

// 413: the files of one report weigh more than `max` MB together.
export const filesTooLarge = (maxBytes: number) =>
  fail("intake.errors.files-too-large", {
    status: 413,
    field: "files",
    params: { max: Math.round(maxBytes / (1024 * 1024)) },
  });

// 403: the ticket is missing, damaged, forged, or names another slot.
export const ticketInvalid = () =>
  fail("intake.errors.ticket-invalid", { status: 403 });

// 410: the ticket's 15 minutes are over.
export const ticketExpired = () =>
  fail("intake.errors.ticket-expired", { status: 410 });

// 409: the slot was filled already (or is being filled).
export const ticketUsed = () =>
  fail("intake.errors.ticket-used", { status: 409 });

// 400: the upload is not the file the ticket was made for (its type or its
// declared length).
export const uploadMismatch = () =>
  fail("intake.errors.upload-mismatch", { status: 400 });

// 403: the organisation's quarantine is full.
export const quarantineFull = () =>
  fail("intake.errors.quarantine-full", { status: 403 });

// 404: no such report file, or one the viewer may not read while it is
// quarantined (the same answer, so a stranger learns nothing), or a tracking
// token with no such thumbnail.
export const fileNotFound = () =>
  fail("intake.errors.file-not-found", { status: 404 });

// 401: the `x-pulsarix-identity` token is forged, expired, not yet valid, over
// 24 hours, signed for another key, or its key has no identity secret. One
// answer for all, so a caller learns nothing about which check failed.
export const identityInvalid = () =>
  fail("intake.errors.identity-invalid", { status: 401 });

// 409: the request was resolved more than 30 days ago: it cannot be reopened.
export const reopenExpired = () =>
  fail("intake.errors.reopen-expired", { status: 409 });

// 409: the request was declined: it is read only, nothing can be added to it.
export const requestDeclined = () =>
  fail("intake.errors.request-declined", { status: 409 });

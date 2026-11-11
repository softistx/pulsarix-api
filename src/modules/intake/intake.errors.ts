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

// An origin of the allow-list that is not `scheme://host[:port]`.
export const invalidOrigin = (origin: string) =>
  fail("intake.errors.invalid-origin", {
    status: 400,
    field: "allowedOrigins",
    params: { origin: origin.slice(0, 100) },
  });

import { GraphQLError } from "graphql";
import { i18n } from "../../../i18n";
import type { ErrorCode } from "../../../i18n/codes";
import type { Params } from "../../../i18n/params";

// A refused operation: `extensions.code` is the error code, stable, which
// clients map to their own translation; `message` is that key translated in
// the request's language, their fallback; `extensions.params`, when given, are
// the values that message interpolates, so a client can word the refusal
// itself; `extensions.http.status`, when given, is the HTTP status Yoga
// answers a top-level failure with. A refusal about an input field is an issue
// of `invalidInput`, not a code of its own.
export function fail(
  code: ErrorCode,
  options: { params?: Params; status?: number; field?: string } = {},
): GraphQLError {
  return new GraphQLError(i18n.t(code, options.params), {
    extensions: {
      code,
      // The input field a refusal is about (a conflict that no `@constraint`
      // can name), for the client to show beside it.
      ...(options.field && { field: options.field }),
      ...(options.params && { params: options.params }),
      ...(options.status && { http: { status: options.status } }),
    },
  });
}

// janus's store (sessions, accounts, relations) could not answer: 503, never a
// refusal, which would read as "signed out" or "not allowed".
export const unavailable = () =>
  fail("auth.errors.unavailable", { status: 503 });

// Concurrent writes kept beating this one: 409, the client may send the request
// again.
export const exhausted = () => fail("auth.errors.exhausted", { status: 409 });

// The params of a refusal that says when to try again: `retryAfter` in whole
// seconds and `minutes`, the same wait rounded up to whole minutes (at least
// 1), which the messages word instead of counting seconds.
export const retryParams = (retryAfter: number) => ({
  retryAfter,
  minutes: Math.max(1, Math.ceil(retryAfter / 60)),
});

// Too many tries, or too many mails: 429 `auth.errors.too-many-attempts`, with
// `retryAfter` (seconds) and `minutes` (rounded up) in `extensions` and
// `extensions.params`, and `reason: "throttled"` (what `@alxia/react-router`'s
// `codeRefusal` recognises as a timed wait).
export function tooManyAttempts(retryAfter: number) {
  const params = retryParams(retryAfter);
  return new GraphQLError(i18n.t("auth.errors.too-many-attempts", params), {
    extensions: {
      code: "auth.errors.too-many-attempts",
      reason: "throttled",
      params,
      http: { status: 429 },
      ...params,
    },
  });
}

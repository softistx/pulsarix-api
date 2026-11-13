import { fail } from "../../core/shared/errors";
import { ChronixLinkError, ChronixUnavailableError } from "./chronix";

// No chronix link in this organisation.
export const notLinked = () => fail("time.errors.not-linked", { status: 409 });

// chronix refused the key (unknown, revoked, malformed).
export const invalidKey = () =>
  fail("time.errors.invalid-key", { status: 400, field: "key" });

// chronix did not answer: later. Only the mutations raise it; the issue's
// `timeSpent` degrades to the `UNAVAILABLE` status instead.
export const unavailable = () =>
  fail("time.errors.unavailable", { status: 503 });

// The acting account's e-mail is not verified, so chronix cannot be told who
// acts: timers and logs are refused (reading the time still works).
export const emailUnverified = () =>
  fail("time.errors.email-unverified", { status: 403 });

// The member may not track time in the linked chronix organisation.
export const forbidden = () => fail("time.errors.forbidden", { status: 403 });

// The issue's project has no mapping in chronix (an admin maps it there).
export const projectNotMapped = () =>
  fail("time.errors.project-not-mapped", { status: 422 });

export const periodLocked = () =>
  fail("time.errors.period-locked", { status: 409 });

export const rateLimited = (retryAfter: number) =>
  fail("time.errors.rate-limited", { status: 429, params: { retryAfter } });

// A chronix failure as the API's error, for the mutations.
export function chronixFailure(error: unknown): unknown {
  if (error instanceof ChronixUnavailableError) return unavailable();
  if (!(error instanceof ChronixLinkError)) return error;
  switch (error.code) {
    case "link.unauthenticated":
      return invalidKey();
    case "link.actor-not-member":
    case "link.forbidden":
      return forbidden();
    case "link.project-not-mapped":
      return projectNotMapped();
    case "period.locked":
      return periodLocked();
    case "rate-limited":
      return rateLimited(error.retryAfterSeconds ?? 60);
    default:
      return unavailable();
  }
}

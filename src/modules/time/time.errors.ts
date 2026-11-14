import {
  isChronixLinkError,
  isChronixUnavailable,
} from "@softistx/chronix-react/server";
import { fail } from "../../core/shared/errors";

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
// acts: timers and logs are refused, and the issue's `timeSpent` is FORBIDDEN
// (chronix wants a verified e-mail on reads too, link-api.md section 7).
export const emailUnverified = () =>
  fail("time.errors.email-unverified", { status: 403 });

// The member may not track time in the linked chronix organisation.
export const forbidden = () => fail("time.errors.forbidden", { status: 403 });

// The key is valid but belongs to another application or another organisation
// than this one (its `partnerApp` or `partnerOrganisationId` differs).
export const keyMismatch = () =>
  fail("time.errors.key-mismatch", { status: 422, field: "key" });

// The issue's project has no mapping in chronix (an admin maps it there).
export const projectNotMapped = () =>
  fail("time.errors.project-not-mapped", { status: 422 });

export const periodLocked = () =>
  fail("time.errors.period-locked", { status: 409 });

// The chronix project the issue's project maps to was archived (409).
export const projectArchived = () =>
  fail("time.errors.project-archived", { status: 409 });

// The chronix project is already mapped to another partner project (409).
export const projectMapped = () =>
  fail("time.errors.project-mapped", { status: 409 });

// The entry's project or task was archived in chronix meanwhile (409).
export const archived = () => fail("time.errors.archived", { status: 409 });

// `mapProject` named a chronix project that does not exist (404).
export const catalogueProjectNotFound = () =>
  fail("time.errors.catalogue-project-not-found", { status: 404 });

export const rateLimited = (retryAfter: number) =>
  fail("time.errors.rate-limited", { status: 429, params: { retryAfter } });

// A chronix failure as the API's error, for the mutations.
export function chronixFailure(error: unknown): unknown {
  if (isChronixUnavailable(error)) return unavailable();
  if (!isChronixLinkError(error)) return error;
  switch (error.code) {
    case "link.unauthenticated":
    // The link was revoked during the request: like a refused key.
    case "links.revoked":
      return invalidKey();
    case "link.actor-not-member":
    case "link.forbidden":
      return forbidden();
    case "link.project-not-mapped":
      return projectNotMapped();
    case "links.project-archived":
      return projectArchived();
    case "links.project-mapped":
      return projectMapped();
    case "time.archived":
      return archived();
    case "catalogue.project-not-found":
      return catalogueProjectNotFound();
    case "period.locked":
      return periodLocked();
    case "rate-limited":
      return rateLimited(error.retryAfterSeconds ?? 60);
    default:
      return unavailable();
  }
}

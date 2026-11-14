import { describe, expect, test } from "bun:test";
import {
  ChronixLinkError,
  ChronixUnavailableError,
} from "@softistx/chronix-react/server";
import type { GraphQLError } from "graphql";
import { chronixFailure } from "./time.errors";

// What pulsarix adds on top of the package's client: the mapping of chronix's
// errors to its own codes. The HTTP behaviour (transport, timeout, 429,
// non-JSON bodies) belongs to `@softistx/chronix-react` and is tested there.
const mapped = (error: unknown) => {
  const failure = chronixFailure(error) as GraphQLError;
  return {
    code: failure.extensions["code"],
    status: (failure.extensions["http"] as { status: number }).status,
    params: failure.extensions["params"],
  };
};

describe("chronix errors as the API's errors", () => {
  test.each([
    ["link.unauthenticated", "time.errors.invalid-key", 400],
    ["links.revoked", "time.errors.invalid-key", 400],
    ["link.actor-not-member", "time.errors.forbidden", 403],
    ["link.forbidden", "time.errors.forbidden", 403],
    ["link.project-not-mapped", "time.errors.project-not-mapped", 422],
    ["period.locked", "time.errors.period-locked", 409],
    ["something.new", "time.errors.unavailable", 503],
  ])("%s becomes %s", (code, expected, status) => {
    expect(mapped(new ChronixLinkError(code, code))).toMatchObject({
      code: expected,
      status,
    });
  });

  test("an outage is unavailable", () => {
    expect(mapped(new ChronixUnavailableError("down"))).toMatchObject({
      code: "time.errors.unavailable",
      status: 503,
    });
  });

  test("rate-limited carries chronix's delay, 60 s without one", () => {
    const limited = (retryAfterSeconds?: number) =>
      mapped(
        new ChronixLinkError("rate-limited", "slow", {
          retryAfterSeconds: retryAfterSeconds ?? null,
        }),
      );
    expect(limited(12)).toMatchObject({
      status: 429,
      params: { retryAfter: 12 },
    });
    expect(limited()).toMatchObject({ params: { retryAfter: 60 } });
  });

  test("an error that is not chronix's passes through", () => {
    const other = new Error("boom");
    expect(chronixFailure(other)).toBe(other);
  });
});

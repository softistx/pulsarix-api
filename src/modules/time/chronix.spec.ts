import { describe, expect, test } from "bun:test";
import {
  ChronixLinkError,
  ChronixUnavailableError,
  createChronixLinkClient,
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

  test("a 429 with no code, from the real client, ends as rate-limited with its Retry-After", async () => {
    const answer = (headers: Record<string, string>) =>
      createChronixLinkClient({
        baseUrl: "https://chronix.test",
        key: "chx_link_any",
        fetch: Object.assign(
          async () => new Response("slow down", { status: 429, headers }),
          { preconnect: () => {} },
        ),
      })
        .as("member@example.test")
        .runningTimer()
        .then(
          () => {
            throw new Error("expected a refusal");
          },
          (error: unknown) => mapped(error),
        );
    expect(await answer({ "Retry-After": "7" })).toMatchObject({
      code: "time.errors.rate-limited",
      status: 429,
      params: { retryAfter: 7 },
    });
    expect(await answer({})).toMatchObject({
      code: "time.errors.rate-limited",
      params: { retryAfter: 60 },
    });
  });

  test("an error that is not chronix's passes through", () => {
    const other = new Error("boom");
    expect(chronixFailure(other)).toBe(other);
  });
});

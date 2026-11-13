import { describe, expect, test } from "bun:test";
import {
  ChronixLinkError,
  ChronixUnavailableError,
  createChronixLinkClient,
} from "./chronix";

interface Seen {
  url: string;
  headers: Headers;
  body: { query: string; variables: unknown };
}

// A fetch that answers `respond` and remembers what it was sent.
function stub(respond: (init: RequestInit) => Promise<Response> | Response) {
  const seen: Seen[] = [];
  const fetchStub = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    seen.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return respond(init ?? {});
  }) as typeof fetch;
  return { seen, fetchStub };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const client = (fetchStub: typeof fetch, timeoutMs?: number) =>
  createChronixLinkClient({
    baseUrl: "https://chronix.test/",
    key: "chx_link_secret",
    fetch: fetchStub,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });

describe("the chronix link client over HTTP", () => {
  test("posts to /link/graphql with the link key and the actor's e-mail", async () => {
    const { seen, fetchStub } = stub(() => json({ data: { totals: [] } }));
    await client(fetchStub).as("ada@example.test").totals([]);
    const [call] = seen;
    expect(call?.url).toBe("https://chronix.test/link/graphql");
    expect(call?.headers.get("authorization")).toBe("Link chx_link_secret");
    expect(call?.headers.get("x-chronix-actor")).toBe("ada@example.test");
    expect(call?.headers.get("content-type")).toBe("application/json");
  });

  test("the key-level call sends no actor", async () => {
    const { seen, fetchStub } = stub(() =>
      json({
        data: {
          link: {
            partnerApp: "pulsarix",
            partnerOrganisationId: "o",
            organisationName: "Acme",
            timeZone: "UTC",
          },
        },
      }),
    );
    expect((await client(fetchStub).link()).organisationName).toBe("Acme");
    expect(seen[0]?.headers.get("authorization")).toBe("Link chx_link_secret");
    expect(seen[0]?.headers.has("x-chronix-actor")).toBe(false);
  });

  test("a call that hangs past timeoutMs is ChronixUnavailableError", async () => {
    const { fetchStub } = stub(
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const started = Date.now();
    const failure = await client(fetchStub, 50)
      .as("ada@example.test")
      .totals([])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChronixUnavailableError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a 503 is ChronixUnavailableError", async () => {
    const { fetchStub } = stub(() => new Response("down", { status: 503 }));
    const failure = await client(fetchStub)
      .link()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChronixUnavailableError);
  });

  test("a 429 is ChronixLinkError rate-limited with its delay", async () => {
    const { fetchStub } = stub(() =>
      json(
        {
          errors: [
            {
              message: "slow down",
              extensions: { code: "rate-limited", retryAfterSeconds: 12 },
            },
          ],
        },
        429,
      ),
    );
    const failure = await client(fetchStub)
      .as("ada@example.test")
      .totals([])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChronixLinkError);
    expect((failure as ChronixLinkError).code).toBe("rate-limited");
    expect((failure as ChronixLinkError).retryAfterSeconds).toBe(12);
  });

  test("a 401 carries the contract's code", async () => {
    const { fetchStub } = stub(() =>
      json(
        {
          errors: [
            { message: "no", extensions: { code: "link.unauthenticated" } },
          ],
        },
        401,
      ),
    );
    const failure = await client(fetchStub)
      .link()
      .catch((error: unknown) => error);
    expect((failure as ChronixLinkError).code).toBe("link.unauthenticated");
  });

  test("an HTML body (a proxy's error page) is ChronixUnavailableError", async () => {
    const { fetchStub } = stub(
      () =>
        new Response("<html><body>Bad gateway page</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const failure = await client(fetchStub)
      .link()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChronixUnavailableError);
  });

  test("a network error is ChronixUnavailableError", async () => {
    const { fetchStub } = stub(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const failure = await client(fetchStub)
      .link()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChronixUnavailableError);
  });
});

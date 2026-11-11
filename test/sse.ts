import { DEFAULT_HEADER as organisationHeader } from "@alxia/tenancy";
import { clientHeader } from "../src/http/csrf";
import type { AuthApp } from "./auth";

// One result of a subscription, as the SSE `next` event carries it.
export interface LiveResult<T = Record<string, unknown>> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

// A subscription over the real app, read as the server-sent events a browser
// would: `status` is the HTTP status of the answer, `next()` the next result
// (null once the stream ended), `close()` leaves like a closed tab.
export async function subscribe<T = Record<string, unknown>>(
  kit: Pick<AuthApp, "app">,
  token: string | null,
  options: { organisation?: string },
  query: string,
  variables?: Record<string, unknown>,
) {
  const controller = new AbortController();
  const response = await kit.app.fetch(
    new Request("https://ui.pulsarix.test/graphql", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        [clientHeader]: "spec",
        ...(token && { authorization: `Bearer ${token}` }),
        ...(options.organisation && {
          [organisationHeader]: options.organisation,
        }),
      },
      body: JSON.stringify({ query, variables }),
    }),
  );
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const results: LiveResult<T>[] = [];
  let ended = false;
  const pump = (async () => {
    try {
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (data) results.push(JSON.parse(data) as LiveResult<T>);
        }
      }
    } catch {
      // aborted
    }
    ended = true;
  })();
  // A non-stream answer (a refusal before the stream opens) is plain JSON.
  const refusal =
    response.headers.get("content-type")?.includes("text/event-stream") ===
    false;
  return {
    status: response.status,
    refusal,
    // The next result, waiting up to `ms`; null when the stream ended or
    // nothing came.
    async next(ms = 2_000): Promise<LiveResult<T> | null> {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const first = results.shift();
        if (first) return first;
        if (ended) return null;
        await Bun.sleep(10);
      }
      return null;
    },
    // Whether nothing arrives within `ms`.
    async quiet(ms = 300): Promise<boolean> {
      await Bun.sleep(ms);
      return results.length === 0;
    },
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await pump;
    },
  };
}

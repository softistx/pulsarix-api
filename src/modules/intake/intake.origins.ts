import { invalidOrigin } from "./intake.errors";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// An entry of a key's allow-list, in the one text a browser sends as `Origin`
// (`URL.origin`: lower case, default port dropped). Only `https://host[:port]`,
// or `http://` for a local host; no path, query, fragment, credentials or
// wildcard. Null for anything else.
export function normaliseOrigin(given: string): string | null {
  const text = given.trim();
  if (text.length === 0 || text.length > 200 || /[*\s]/.test(text)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/") return null;
  return url.origin;
}

// The allow-list as stored: each entry normalised, none twice; a bad entry is
// a 400 on `allowedOrigins`.
export function allowListOf(given: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of given) {
    const origin = normaliseOrigin(entry);
    if (!origin) throw invalidOrigin(entry);
    seen.add(origin);
  }
  return [...seen];
}

// Whether the request's `Origin` header is one of the list. A request with no
// `Origin` (not a browser) is not: it is refused, the same as a foreign one.
export function originAllowed(
  header: string | null,
  allowed: readonly string[],
): header is string {
  return header !== null && allowed.includes(header);
}

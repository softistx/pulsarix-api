import { createHash, timingSafeEqual } from "node:crypto";
import { forwardedIp, type TrustedProxies } from "@alxia/core";

// Temporary, until @alxia/core#747 (tracking: pulsarix-api#57): alxia's `ip`
// option is one function for the whole app, with no per-route trust, so the path
// is read here.

export const PROXY_SECRET_HEADER = "x-pulsarix-proxy-secret";

// The widget's endpoint: called by browsers through Traefik, never by the UI's
// server, so it cannot carry the secret.
const OPEN_PREFIX = "/public/";

type IpOf = (
  request: Request,
  server: Bun.Server<unknown> | undefined,
) => string | undefined;

const digest = (value: string) => createHash("sha256").update(value).digest();

// Constant time: both sides are hashed first, so their lengths always match.
const sameSecret = (given: string | null, secret: string) =>
  given !== null && timingSafeEqual(digest(given), digest(secret));

// The `ip` option behind proxies. Under /public/, forwardedIp's behaviour
// (TRUSTED_PROXIES alone). Elsewhere (/graphql, the media routes), with `secret`
// (API_PROXY_SECRET), the forwarded address is honoured only on a request that
// carries it in `x-pulsarix-proxy-secret` (the UI's server sends it); any other
// request, whatever it claims in X-Forwarded-For, is the connection's address.
// Without `secret`, forwardedIp's behaviour everywhere.
export function proxyIp(options: {
  trusted: TrustedProxies;
  secret?: string | undefined;
}): IpOf {
  const forwarded = forwardedIp({ trusted: options.trusted });
  const { secret } = options;
  if (!secret) return forwarded;
  return (request, server) =>
    new URL(request.url).pathname.startsWith(OPEN_PREFIX) ||
    sameSecret(request.headers.get(PROXY_SECRET_HEADER), secret)
      ? forwarded(request, server)
      : server?.requestIP(request)?.address;
}

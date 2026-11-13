import { timingSafeEqual } from "node:crypto";
import { forwardedIp, type TrustedProxies } from "@alxia/core";

export const PROXY_SECRET_HEADER = "x-pulsarix-proxy-secret";

type IpOf = (
  request: Request,
  server: Bun.Server<unknown> | undefined,
) => string | undefined;

const sameSecret = (given: string | null, secret: string) => {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

// The `ip` option behind proxies. With `secret` (API_PROXY_SECRET), the forwarded
// address is honoured only on a request that carries it in
// `x-pulsarix-proxy-secret` (the UI's server sends it); any other request,
// whatever it claims in X-Forwarded-For, is the connection's address. Without
// `secret`, forwardedIp's behaviour, unchanged.
export function proxyIp(options: {
  trusted: TrustedProxies;
  secret?: string | undefined;
}): IpOf {
  const forwarded = forwardedIp({ trusted: options.trusted });
  const { secret } = options;
  if (!secret) return forwarded;
  return (request, server) =>
    sameSecret(request.headers.get(PROXY_SECRET_HEADER), secret)
      ? forwarded(request, server)
      : server?.requestIP(request)?.address;
}

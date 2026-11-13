import { addressKey } from "./address";
import { tooManyAttempts, unavailable } from "./errors";
import type { IpLimit } from "./ip.limits";

interface Consumable<P> {
  consume(
    params: P,
    cost?: number,
    options?: { timeoutMs?: number },
  ): Promise<{ allowed: boolean; retryAfter: number }>;
}

// Spends one try of `limit`. 429 `auth.errors.too-many-attempts` past it; a
// limit that cannot be checked is a 503 (fail closed, never a free pass) and
// is logged with `label`.
export async function consumeOrRefuse<P>(
  limit: Consumable<P>,
  params: P,
  label: string,
  log: (message: string, error: unknown) => void = console.warn,
) {
  let result: { allowed: boolean; retryAfter: number };
  try {
    result = await limit.consume(params, 1, { timeoutMs: 1_000 });
  } catch (error) {
    log(`${label} rate limit unavailable`, error);
    throw unavailable();
  }
  if (!result.allowed) {
    throw tooManyAttempts(Math.ceil(result.retryAfter / 1000));
  }
}

// The per-address limit of an anonymous mutation. No limit (no Redis): nothing.
export async function throttleIp(
  limit: IpLimit | undefined,
  ip: string | undefined,
  log?: (message: string, error: unknown) => void,
) {
  if (!limit) return;
  await consumeOrRefuse(limit, { ip: addressKey(ip) }, "per-address", log);
}

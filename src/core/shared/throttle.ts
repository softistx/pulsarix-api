import { addressKey } from "./address";
import { tooManyAttempts, unavailable } from "./errors";
import type { IpLimit } from "./ip.limits";

// Spends one try of `limit` for the address. 429 `auth.errors.too-many-attempts`
// past it; a limit that cannot be checked is a 503, never a free pass (fail
// closed, like organisation creation and the intake). No limit (no Redis): nothing.
export async function throttleIp(
  limit: IpLimit | undefined,
  ip: string | undefined,
  log: (message: string, error: unknown) => void = console.warn,
) {
  if (!limit) return;
  let result: { allowed: boolean; retryAfter: number };
  try {
    result = await limit.consume({ ip: addressKey(ip) }, 1, {
      timeoutMs: 1_000,
    });
  } catch (error) {
    log("per-address rate limit unavailable", error);
    throw unavailable();
  }
  if (!result.allowed) {
    throw tooManyAttempts(Math.ceil(result.retryAfter / 1000));
  }
}

import { defineRateLimit } from "@softistx/redis";

// The rate limit of organisation creation (src/config/limits.ts gathers the
// limits, src/config/redis.ts wires them under the `pulsarix` prefix). The
// window is in milliseconds.

// Organisations created by one account: each one provisions a database.
export const organisationCreate = defineRateLimit({
  name: "organisations.create",
  key: (p: { accountId: string }) => p.accountId,
  limit: 5,
  per: 60 * 60_000,
});

// What the service asks of that limit: `consume` is the bound limit of
// @softistx/redis.
export interface OrganisationLimits {
  organisationCreate: {
    consume(
      params: { accountId: string },
      cost?: number,
      options?: { timeoutMs?: number },
    ): Promise<{ allowed: boolean; retryAfter: number }>;
  };
}

// Organisations an account may own at once.
export const MAX_OWNED_ORGANISATIONS = 10;

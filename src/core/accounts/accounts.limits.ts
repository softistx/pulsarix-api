import { defineRateLimit } from "@softistx/redis";

// The rate limit of `requestEmailVerification` (src/config/limits.ts gathers
// the limits, src/config/redis.ts wires them under the `pulsarix` prefix). The
// window is in milliseconds. janus counts the mails of one address itself
// (5 per 10 minutes, `prepare`); this caps what one account can ask in an hour.
// It is spent before anything is read about the account, so the answer is the
// same whether or not the e-mail is proved.

// Verification mails requested by one account.
export const emailVerificationAccount = defineRateLimit({
  name: "accounts.email-verification-account",
  key: (p: { accountId: string }) => p.accountId,
  limit: 10,
  per: 60 * 60_000,
});

// What the resolver asks of that limit: `consume` is the bound limit of
// @softistx/redis.
export interface AccountLimits {
  emailVerificationAccount: {
    consume(
      params: { accountId: string },
      cost?: number,
      options?: { timeoutMs?: number },
    ): Promise<{ allowed: boolean; retryAfter: number }>;
  };
}

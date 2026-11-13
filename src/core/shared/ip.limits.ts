import { defineRateLimit } from "@softistx/redis";

// The per-address rate limits of the anonymous mutations (src/config/limits.ts
// gathers the limits, src/config/redis.ts wires them under the `pulsarix`
// prefix). janus throttles the passwords of one e-mail and the mails of one
// address itself; these cap what one address can open. The client address is
// `ctx.ip`, read from TRUSTED_PROXIES / API_PROXY_SECRET (src/http/client-ip.ts).
// Windows are in milliseconds.

const HOUR = 60 * 60_000;

// Accounts created from one address.
export const signUpIp = defineRateLimit({
  name: "accounts.sign-up-ip",
  key: (p: { ip: string }) => p.ip,
  limit: 10,
  per: HOUR,
});

// Invitation links followed (accepted or guessed) from one address.
export const acceptInvitationIp = defineRateLimit({
  name: "invitations.accept-ip",
  key: (p: { ip: string }) => p.ip,
  limit: 20,
  per: HOUR,
});

export type IpLimit = {
  consume(
    params: { ip: string },
    cost?: number,
    options?: { timeoutMs?: number },
  ): Promise<{ allowed: boolean; retryAfter: number }>;
};

// What the services ask of those limits: `consume` is the bound limit of
// @softistx/redis.
export interface IpLimits {
  signUpIp: IpLimit;
  acceptInvitationIp: IpLimit;
}

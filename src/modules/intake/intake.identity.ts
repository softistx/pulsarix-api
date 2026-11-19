import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parseSealingKeys, sealerFor } from "@softistx/janus";
import { z } from "zod";
import { env } from "../../config/env";
import { identityInvalid } from "./intake.errors";
import type { IntakeLimits, Limiter } from "./intake.limits.types";

// The reporter identity of plan §19: the host's server signs a token for its
// signed-in user, the widget sends it in `x-pulsarix-identity`, and the report
// is saved under the reporter the token names.
//
//   <payload>.<signature>, both base64url
//   payload   JSON { sub, email?, name?, aud, iat, exp }
//   signature HMAC-SHA256 of the payload segment (the text as sent) with the
//             key's identity secret
//
// There is no algorithm field, so no `none` and no downgrade.

export const IDENTITY_HEADER = "x-pulsarix-identity";

// A token lives 24 hours at most (1 hour is recommended); `iat` may be 5
// minutes ahead and `exp` 5 minutes past, for the clocks of two servers.
export const MAX_LIFETIME_S = 24 * 60 * 60;
export const SKEW_S = 5 * 60;
const MAX_TOKEN = 2_048;

const payload = z.object({
  sub: z.string().min(1).max(200),
  email: z.string().max(254).pipe(z.email()).optional(),
  name: z.string().trim().max(100).optional(),
  aud: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export interface Identity {
  // The SHA-256 of the key id and `sub`: what the reports are filed under.
  reporterKey: string;
  reporterName: string | null;
  email: string | null;
  // When the token stops being valid: a live stream ends then.
  expiresAt: Date;
}

// The secret is sealed before any store sees it: janus `sealerFor` under the
// application's sealing keys (TOTP_KEYS), bound to the widget key's id, so a
// sealed secret copied onto another key does not open. Built once, at first use.
const PURPOSE = "pulsarix:widget-identity-secret";
let cached: ReturnType<typeof sealerFor> | undefined;
const sealer = () => {
  cached ??= sealerFor(
    parseSealingKeys(env.TOTP_KEYS, { where: "TOTP_KEYS" }),
    PURPOSE,
  );
  return cached;
};

// 256 random bits, as the host copies them once.
export const newIdentitySecret = () => randomBytes(32).toString("base64url");

export const sealIdentitySecret = (plain: string, keyId: string) =>
  sealer().seal(keyId, plain);

// Null when the value does not open (an unknown sealing key id, a tampered
// value, a value sealed for another key).
export const openIdentitySecret = (sealed: string, keyId: string) =>
  sealer().unseal(keyId, sealed);

// `sub` is never stored: the reporter is this digest, per key, so one user of
// the host is a different reporter under each key.
export const reporterKeyOf = (keyId: string, sub: string) =>
  createHash("sha256").update(`${keyId}\n${sub}`).digest("hex");

const decode = (segment: string) => Buffer.from(segment, "base64url");
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// The identity a token vouches for, or a 401 `intake.errors.identity-invalid`
// for anything else, whatever the reason (the answer names none).
export function verifyIdentity(
  token: string,
  key: {
    id: string;
    publicKey: string;
    identitySecret?: string | null | undefined;
  },
  now: Date,
): Identity {
  const secret = key.identitySecret
    ? openIdentitySecret(key.identitySecret, key.id)
    : null;
  const [body, signature, ...rest] = token.split(".");
  // The signature is checked first, and in constant time: nothing in the
  // payload is read before it matches.
  if (
    !secret ||
    token.length > MAX_TOKEN ||
    rest.length > 0 ||
    !body ||
    !signature ||
    !BASE64URL.test(body) ||
    !BASE64URL.test(signature)
  ) {
    throw identityInvalid();
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = decode(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw identityInvalid();
  }
  let claims: z.infer<typeof payload>;
  try {
    const parsed = payload.safeParse(JSON.parse(decode(body).toString("utf8")));
    if (!parsed.success) throw identityInvalid();
    claims = parsed.data;
  } catch {
    throw identityInvalid();
  }
  const seconds = Math.floor(now.getTime() / 1000);
  if (
    claims.aud !== key.publicKey ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_LIFETIME_S ||
    claims.iat > seconds + SKEW_S ||
    claims.exp < seconds - SKEW_S
  ) {
    throw identityInvalid();
  }
  return {
    reporterKey: reporterKeyOf(key.id, claims.sub),
    reporterName: claims.name || null,
    email: claims.email ?? null,
    expiresAt: new Date(claims.exp * 1000),
  };
}

// The identity step of a submission: a token that is sent must be good (a bad
// one is a 401 and nothing is kept, not a report that silently loses its
// identity), and an identified reporter is rate limited on their own key. No
// token, no change: null.
export async function identifyCaller(
  intake: {
    now(): Date;
    limit<P>(
      pick: (limits: IntakeLimits) => Limiter<P>,
      params: P,
      cost?: number,
    ): Promise<void>;
  },
  key: Parameters<typeof verifyIdentity>[1],
  token: string | null | undefined,
): Promise<Identity | null> {
  if (token == null) return null;
  const identity = verifyIdentity(token, key, intake.now());
  await intake.limit((l) => l.intakeReporter, {
    keyId: key.id,
    reporterKey: identity.reporterKey,
  });
  return identity;
}

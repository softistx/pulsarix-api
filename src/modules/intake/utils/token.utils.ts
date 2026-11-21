import { createHash, randomBytes } from "node:crypto";

// The public key of a widget: `pk_live_` and 24 random bytes (192 bits).
export const newPublicKey = () =>
  `pk_live_${randomBytes(24).toString("base64url")}`;

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const ORGANISATION = /^[0-9a-f]{24}$/;

// A tracking token: `<organisation id>.<secret>`, the secret being 256 random
// bits. The organisation id only tells the server which database to open (it
// is no secret and grants nothing); the secret is mailed once to the reporter
// and only its SHA-256 is stored, so a leaked database opens no tracking page.
export function newTrackingToken(organisationId: string) {
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `${organisationId}.${secret}`,
    hash: hashSecret(secret),
  };
}

export const hashSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

// The organisation and the secret's hash a token names, or null for anything
// that is not spelled like one (no database is touched for it).
export function parseTrackingToken(
  token: string,
): { organisationId: string; hash: string } | null {
  const [organisationId, secret, ...rest] = token.split(".");
  if (rest.length > 0 || !organisationId || !secret) return null;
  if (!ORGANISATION.test(organisationId) || !SECRET.test(secret)) return null;
  return { organisationId, hash: hashSecret(secret) };
}

// What a rate limit keys on for an e-mail address: a digest, so no address is
// written to Redis.
export const emailDigest = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

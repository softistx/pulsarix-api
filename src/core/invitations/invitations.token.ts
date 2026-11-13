import { createHash, randomBytes } from "node:crypto";

// How long an invitation's link works.
export const lifespan = 7 * 24 * 60 * 60 * 1000;

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// The token of an invitation's link: 32 random bytes in base64url. Only its
// sha256 is stored.
export function invitationToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256(token) };
}

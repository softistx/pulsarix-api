import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { parseSealingKeys } from "@softistx/janus";
import { env } from "../../config/env";

// Temporary, until nxgt-janus#735: a sealing helper in @softistx/janus replaces this file.
//
// The link key is sealed before any store sees it: AES-256-GCM under the
// application's sealing keys (TOTP_KEYS, the keys the second factor's secrets
// use), `v1.<key id>.<iv>.<ciphertext and tag>`, bound to the organisation's id
// as additional data, so a sealed key copied onto another organisation does not
// open. The cipher key is derived from the sealing key for this purpose alone
// (HKDF-SHA-256, info `pulsarix:chronix-link-key`), so the raw second-factor
// key never encrypts a link key. The first key seals, every key opens.
const keys = () => parseSealingKeys(env.TOTP_KEYS, { where: "TOTP_KEYS" });

const INFO = "pulsarix:chronix-link-key";
const derive = (key: string) =>
  Buffer.from(
    hkdfSync("sha256", Buffer.from(key, "base64"), Buffer.alloc(0), INFO, 32),
  );

export function sealLinkKey(plain: string, organisationId: string): string {
  const [first] = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(first.key), iv);
  cipher.setAAD(Buffer.from(organisationId));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);
  return `v1.${first.id}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

// Null when the value does not open (an unknown key id, a tampered value).
export function openLinkKey(
  sealed: string,
  organisationId: string,
): string | null {
  const [version, id, iv, body, ...rest] = sealed.split(".");
  if (version !== "v1" || !id || !iv || !body || rest.length > 0) return null;
  const key = keys().find((candidate) => candidate.id === id);
  if (!key) return null;
  try {
    const raw = Buffer.from(body, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(key.key),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(organisationId));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

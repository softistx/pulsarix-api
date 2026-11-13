import { createDecipheriv, hkdfSync } from "node:crypto";
import { parseSealingKeys, sealerFor } from "@softistx/janus";
import { env } from "../../config/env";

// The link key is sealed before any store sees it: janus `sealerFor` under the
// application's sealing keys (TOTP_KEYS, the keys the second factor's secrets
// use), `v1.<key id>.<iv>.<ciphertext and tag>`, bound to the organisation's id,
// so a sealed key copied onto another organisation does not open. The first key
// seals, every key opens; rotation is by key id (`needsReseal`).
//
// Values sealed before the adoption of `sealerFor` used the same format with a
// cipher key derived by this file (HKDF-SHA-256, info
// `pulsarix:chronix-link-key`) and the organisation id as additional data.
// Those open through `openLegacy` below, read-only: nothing new is sealed that
// way, and a stored value is never rewritten here.
const TAG_LENGTH = 16;
const PURPOSE = "pulsarix:chronix-link-key";

// Built once, at first use: the unknown-key warning is capped per sealer.
let cached: ReturnType<typeof sealerFor> | undefined;
const sealer = () => {
  cached ??= sealerFor(
    parseSealingKeys(env.TOTP_KEYS, { where: "TOTP_KEYS" }),
    PURPOSE,
  );
  return cached;
};

export function sealLinkKey(plain: string, organisationId: string): string {
  return sealer().seal(organisationId, plain);
}

// Null when the value does not open (an unknown key id, a tampered value, a
// value sealed for another organisation).
export function openLinkKey(
  sealed: string,
  organisationId: string,
): string | null {
  return (
    sealer().unseal(organisationId, sealed) ??
    openLegacy(sealed, organisationId)
  );
}

function openLegacy(sealed: string, organisationId: string): string | null {
  const [version, id, iv, body, ...rest] = sealed.split(".");
  if (version !== "v1" || !id || !iv || !body || rest.length > 0) return null;
  const key = parseSealingKeys(env.TOTP_KEYS, { where: "TOTP_KEYS" }).find(
    (candidate) => candidate.id === id,
  );
  if (!key) return null;
  try {
    const raw = Buffer.from(body, "base64url");
    if (raw.length <= TAG_LENGTH) return null;
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(key.key, "base64"),
        Buffer.alloc(0),
        PURPOSE,
        32,
      ),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derived,
      Buffer.from(iv, "base64url"),
      { authTagLength: TAG_LENGTH },
    );
    decipher.setAAD(Buffer.from(organisationId));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_LENGTH));
    return Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - TAG_LENGTH)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

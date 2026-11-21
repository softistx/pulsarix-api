import { describe, expect, test } from "bun:test";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { parseSealingKeys } from "@softistx/janus";
import { env } from "../../../config/env";
import { openLinkKey, sealLinkKey } from "./seal.utils";

const KEY = "chx_link_good";

describe("the sealed link key", () => {
  test("the key is sealed: it opens only for its organisation and fails when tampered", () => {
    const sealed = sealLinkKey(KEY, "org-1");
    expect(sealed).not.toContain(KEY);
    expect(openLinkKey(sealed, "org-1")).toBe(KEY);
    expect(openLinkKey(sealed, "org-2")).toBeNull();
    expect(openLinkKey(`${sealed}x`, "org-1")).toBeNull();
    expect(openLinkKey("junk", "org-1")).toBeNull();
  });

  // The sealing code before sealerFor, kept here to make the stored values.
  const sealLegacy = (plain: string, organisationId: string) => {
    const [first] = parseSealingKeys(env.TOTP_KEYS, { where: "TOTP_KEYS" });
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(first.key, "base64"),
        Buffer.alloc(0),
        "pulsarix:chronix-link-key",
        32,
      ),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(Buffer.from(organisationId));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const sealed = Buffer.concat([body, cipher.getAuthTag()]);
    return `v1.${first.id}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
  };

  test("a key sealed by the code before sealerFor still opens, for its organisation only", () => {
    const legacy = sealLegacy(KEY, "org-1");
    expect(openLinkKey(legacy, "org-1")).toBe(KEY);
    expect(openLinkKey(legacy, "org-2")).toBeNull();
    expect(openLinkKey(`${legacy}x`, "org-1")).toBeNull();
  });

  test("a value sealed by the old code, kept as a literal, still opens", () => {
    // Made once by develop's sealLinkKey (before sealerFor) with the test key
    // and organisation "org-1".
    const frozen =
      "v1.dev.l8pFHNwyxjSFIjCG.3Umf5y1XVB4AEx26wXMlu8SyCMypS048jDemSmw";
    expect(openLinkKey(frozen, "org-1")).toBe(KEY);
    expect(openLinkKey(frozen, "org-2")).toBeNull();
  });

  test("a legacy value whose body is no longer than the tag does not open", () => {
    for (const bytes of [0, 4, 8, 12, 16]) {
      const body = randomBytes(bytes).toString("base64url");
      const iv = randomBytes(12).toString("base64url");
      expect(openLinkKey(`v1.dev.${iv}.${body}`, "org-1")).toBeNull();
    }
  });
});

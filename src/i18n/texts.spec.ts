import { describe, expect, test } from "bun:test";
import { IntlMessageFormat } from "intl-messageformat";
import { authApp, signedUp } from "~/auth";
import { codeOf } from "~/http";
import { errorCodes } from "./codes";
import { locales } from "./locale";
import { texts } from "./texts";

describe("error texts", () => {
  test("every declared code has an English and a French text, and no text is orphaned", () => {
    for (const locale of locales) {
      expect(errorCodes.filter((code) => !texts[locale][code])).toEqual([]);
      expect(
        Object.keys(texts[locale]).filter((code) => !errorCodes.includes(code)),
      ).toEqual([]);
    }
  });

  test("every text is a valid ICU message", () => {
    for (const locale of locales) {
      for (const [code, text] of Object.entries(texts[locale])) {
        expect(() => new IntlMessageFormat(text, locale), code).not.toThrow();
      }
    }
  });

  test("a refusal speaks English by default and French when asked", async () => {
    const kit = authApp();
    const account = await signedUp(kit);
    const query = `{ members { id } }`;
    const english = await kit
      .client(account.token, { organisation: "0".repeat(24) })
      .attempt(query);
    expect(codeOf(english)).toBe("tenancy.errors.unknown-organization");
    expect(english.errors?.[0]?.message).toBe(
      "This organisation does not exist.",
    );
    const french = await kit
      .client(account.token, { organisation: "0".repeat(24), language: "fr" })
      .attempt(query);
    expect(french.errors?.[0]?.message).toBe(
      "Cette organisation n'existe pas.",
    );
    expect(french.errors?.[0]?.extensions?.code).toBe(
      "tenancy.errors.unknown-organization",
    );
    const interpolated = await kit
      .client(account.token, { language: "fr" })
      .attempt(query);
    expect(interpolated.errors?.[0]?.message).toBe(
      "Indiquez l'organisation dans l'en-tête x-organization-id.",
    );
  });
});

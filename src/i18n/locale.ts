import { i18n } from "./index";

// The languages a mail and a text are written in: English by default, French
// offered (plan Q14).
export const locales = ["en", "fr"] as const;
export type Locale = (typeof locales)[number];

export const isLocale = (value: unknown): value is Locale =>
  locales.some((locale) => locale === value);

// The request's language (Accept-Language, `lang`, cookie), among English and
// French, else English.
export const localeOfRequest = (): Locale =>
  i18n.language() === "fr" ? "fr" : "en";

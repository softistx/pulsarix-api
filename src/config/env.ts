import { defineEnv } from "@alxia/env";
import { z } from "zod";

const production = Bun.env.NODE_ENV === "production";

// Required in production; elsewhere `fallback` stands in.
const inProduction = <T extends z.ZodType>(schema: T, fallback: string) =>
  production ? schema : schema.prefault(fallback as never);

// Optional outside production, required in it: an empty value is unset.
const orUnset = (schema: z.ZodType<string, string>) =>
  production
    ? schema
    : z
        .string()
        .transform((value) => value || undefined)
        .pipe(schema.optional())
        .optional();

const smtpUrl = z
  .string()
  .regex(/^smtps?:\/\/[^/]/, "not an smtp:// or smtps:// URL");

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
// The Redis and S3 variables arrive with the slice that first uses each.
export const env = defineEnv({
  // mongodb:// or mongodb+srv://. Transactions need a replica set:
  // docker-compose.yml starts a one-node one. The URI names no database: the
  // core database and each organisation's are named below.
  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "not a MongoDB URI"),
  // The shared database: the organisation registry, janus's collections and
  // the invitations.
  MONGO_CORE_DATABASE: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,40}$/, "letters, digits and _ only")
    .default("pulsarix_core"),
  // An organisation's database is `<prefix><organisation id>`.
  MONGO_ORGANISATION_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,30}$/, "letters, digits and _ only")
    .default("pulsarix_org_"),
  // How many organisations' databases stay open (least recently used out).
  MONGO_ORGANISATION_CACHE_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(100),
  // UI_ORIGIN: pulsarix-ui's origin, which every link of a mail starts with
  // (/invitations/accept, /auth/magic-link, /auth/reset-password). https in production.
  UI_ORIGIN: inProduction(
    z
      .url({ protocol: production ? /^https$/ : /^https?$/ })
      .transform((url) => url.replace(/\/+$/, "")),
    "http://localhost:5173",
  ),
  // MAIL_FROM: the address every mail is sent from.
  MAIL_FROM: inProduction(z.email(), "noreply@pulsarix.test"),
  // MAIL_URL: the SMTP server mails leave through, smtp:// or smtps://, with
  // its credentials. Required in production; unset elsewhere, mails are
  // printed to the console. docker-compose.yml's Mailpit listens on
  // smtp://localhost:1026.
  MAIL_URL: orUnset(smtpUrl),
  // TOTP_KEYS: the sealing keys of the second factor's secrets, `id:key,id:key`
  // (the first seals, every one opens; each key is `openssl rand -base64 32`).
  // Required in production; elsewhere a fixed development key stands in.
  TOTP_KEYS: inProduction(
    z.string().min(1),
    "dev:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  ),
  // An empty PORT= is unset, not port 0.
  PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65_535).default(3000),
  ),
});

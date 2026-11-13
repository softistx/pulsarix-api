import { parseTrustedProxies } from "@alxia/core";
import { defineEnv } from "@alxia/env";
import { z } from "zod";

const production = Bun.env.NODE_ENV === "production";

// A comma separated list of addresses, CIDR ranges or `cloudflare`, checked by
// `parseTrustedProxies`: a range that trusts every address (`0.0.0.0/0`), a
// port or a typo is refused here, not later in `createBase`. An empty value is unset.
const trustedProxies = z
  .string()
  .transform((value, ctx) => {
    try {
      return parseTrustedProxies(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  })
  .transform((list) => (list.length > 0 ? list : undefined));

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

const unsetIfEmpty = z
  .string()
  .transform((value) => value || undefined)
  .optional();

const smtpUrl = z
  .string()
  .regex(/^smtps?:\/\/[^/]/, "not an smtp:// or smtps:// URL");

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
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
  // REDIS_URL: redis:// or rediss://. The live events (subscriptions) cross
  // API instances through it. Required in production; unset elsewhere, they
  // stay in the one process. docker-compose.yml's Redis listens on
  // redis://localhost:6380.
  REDIS_URL: orUnset(
    z.string().regex(/^rediss?:\/\/[^/]/, "not a redis:// or rediss:// URL"),
  ),
  // TRUSTED_PROXIES: the proxies in front of the API, as addresses or CIDR
  // ranges, comma separated (`172.16.0.0/12` for the docker network). The client
  // address (the public endpoint's rate limits) is read from X-Forwarded-For
  // past these proxies only; never trust a header beyond them. Unset, the
  // address is the connection's: behind a proxy, every client shares one
  // address and one rate limit. Required in production, so that the per-address
  // limits never key on the UI container's address.
  TRUSTED_PROXIES: production
    ? trustedProxies.pipe(
        z.array(z.string(), { error: "required in production" }),
      )
    : trustedProxies.optional(),
  // S3_*: the S3-compatible store of the attachments. All optional: without
  // S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY the media routes answer 503
  // `attachments.errors.unavailable` and nothing else changes. An empty value
  // is unset. docker-compose.yml's MinIO listens on http://localhost:9002.
  S3_ENDPOINT: z
    .string()
    .transform((value) => value || undefined)
    .pipe(z.url({ protocol: /^https?$/ }).optional())
    .optional(),
  S3_REGION: unsetIfEmpty,
  S3_BUCKET: unsetIfEmpty,
  S3_ACCESS_KEY: unsetIfEmpty,
  S3_SECRET_KEY: unsetIfEmpty,
  // CHRONIX_URL: the chronix host whose `/link/graphql` the time tracking calls
  // (link API, contract v1), the origin only. The default is chronix's
  // production host. https in production.
  CHRONIX_URL: z
    .string()
    .transform((value) => value || undefined)
    .pipe(z.url({ protocol: production ? /^https$/ : /^https?$/ }).optional())
    .optional()
    .transform((value) => value ?? "https://chronix.softistx.com"),
  // PULSARIX_MAGIC_LINK: sign-in by a link sent by e-mail. Off by default: off,
  // `requestMagicLink` answers true and sends nothing (the answer for an
  // unknown address), `confirmMagicLink` is refused 503 `auth.errors.unavailable`,
  // and `authConfig.magicLink` is false. 1, true, yes or on turns it on.
  PULSARIX_MAGIC_LINK: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z
      .enum(["", "0", "false", "no", "off", "1", "true", "yes", "on"])
      .default("")
      .transform((value) => ["1", "true", "yes", "on"].includes(value)),
  ),
  // API_PROXY_SECRET: the secret pulsarix-ui's server sends as
  // `x-pulsarix-proxy-secret` (the same variable on both services). Set, the
  // forwarded client address of /graphql is honoured only on a request that
  // carries it (src/http/context.ts); /public/ never carries it (the widget
  // calls through Traefik). Required in production, at least 32 characters;
  // elsewhere an empty value is unset, a set one is still checked.
  API_PROXY_SECRET: production
    ? z.string().min(32, "at least 32 characters")
    : z
        .string()
        .transform((secret) => secret || undefined)
        .pipe(z.string().min(32, "at least 32 characters").optional())
        .optional(),
  // MONGO_AUTO_SYNC: create the validators and indexes of a collection on its
  // first use. Always on outside production; in production only when this is
  // 1, true, yes or on (deploy/docker-compose.yaml sets true: the app user has
  // the dbAdmin role, and each organisation's database is made at runtime).
  MONGO_AUTO_SYNC: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z
      .enum(["", "0", "false", "no", "off", "1", "true", "yes", "on"])
      .default("")
      .transform((value) => ["1", "true", "yes", "on"].includes(value)),
  ),
  // An empty PORT= is unset, not port 0.
  PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65_535).default(3000),
  ),
});

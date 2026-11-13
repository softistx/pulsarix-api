import { dbOf } from "@alxia/tenancy";
import { type Auth, createAuth } from "../core/auth";
import { coreMongo } from "./db";
import { env } from "./env";
import { mailer } from "./mail";

// The janus the server runs, built once: its stores in the CORE database, its
// mails through the mailer (src/config/mail.ts). The app and the operator's
// scripts share it.
let built: Auth | undefined;
export function serverAuth() {
  built ??= createAuth({
    db: dbOf(coreMongo),
    mailer,
    uiOrigin: env.UI_ORIGIN,
    mailFrom: env.MAIL_FROM,
    totpKeys: env.TOTP_KEYS,
    magicLink: env.PULSARIX_MAGIC_LINK,
  });
  return built;
}

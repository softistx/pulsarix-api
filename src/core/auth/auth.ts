import {
  type Clock,
  type MailConfig,
  type PasswordHasher,
  parseSealingKeys,
  systemClock,
} from "@softistx/janus";
import { janusMail } from "@softistx/janus-mail";
import { createMongoAdapter } from "@softistx/janus-mongo";
import type { Mailer } from "@softistx/mail";
import type { Db } from "mongodb";
import { type Background, background } from "../shared/background";
import { createAccounts, organisationPermissions } from "./accounts";
import { MAIL_BRAND_COLOR } from "./brand";
import { mailLinks } from "./links";
import { janusMembership } from "./membership";

export interface AuthOptions {
  // The CORE database: janus keeps its users, sessions, tokens and relations
  // there, shared by every organisation. Never an organisation's database.
  db: Db;
  // Where the mails go: the SMTP server or the console (src/config/mail.ts); a
  // memory mailer in specs.
  mailer: Mailer;
  // pulsarix-ui's origin: every link of a mail starts with it.
  uiOrigin: string;
  // The address every mail is sent from.
  mailFrom: string;
  // The sealing keys of the second factor, `id:key,id:key` (env TOTP_KEYS).
  totpKeys: string;
  // `fixedClock()` in tests: sessions and links expire by it.
  clock?: Clock;
  // scrypt at OWASP's cost by default; a test passes a cheap one.
  hasher?: PasswordHasher;
  // janus's mail throttle (5 requests per 10 minutes by default); a spec
  // that is not about it passes `{ throttle: false }`.
  mail?: MailConfig;
  // Where the mails nobody waits for are sent from.
  background?: Background;
}

// janus, wired for pulsarix, on the core database: one account type, sessions,
// links, a TOTP second factor, and the organisation relations
// (src/core/auth/membership/ reads who is what).
export function createAuth(options: AuthOptions) {
  const clock = options.clock ?? systemClock;
  const store = createMongoAdapter(options.db);
  const links = mailLinks(options.uiOrigin);
  const from = { name: "pulsarix", address: options.mailFrom };
  // janus issues the tokens of a reset, of a sign-in link and of a step-up and
  // sends nothing; janus-mail turns each into an English or French mail.
  const mail = janusMail({
    mailer: options.mailer,
    from,
    brand: { name: "pulsarix", color: MAIL_BRAND_COLOR },
    fallbackLocale: "en",
    clock,
    links: {
      verifyEmail: links.verifyEmail,
      resetPassword: links.resetPassword,
      magicLink: links.magicLink,
      secureAccount: links.secureAccount,
      getStarted: links.getStarted,
    },
  });
  const accounts = createAccounts({
    store,
    clock,
    hasher: options.hasher,
    keys: parseSealingKeys(options.totpKeys, { where: "TOTP_KEYS" }),
    ...(options.mail && { mail: options.mail }),
  });
  const permissions = organisationPermissions(accounts, store.relations);
  return {
    accounts,
    permissions,
    relations: store.relations,
    membership: janusMembership(permissions, store.relations),
    mail,
    mailer: options.mailer,
    from,
    links,
    clock,
    background: options.background ?? background(),
  };
}

export type Auth = ReturnType<typeof createAuth>;

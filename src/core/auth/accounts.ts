import {
  type Clock,
  janus,
  type MailConfig,
  type PasswordHasher,
  type SealingKey,
  scryptHasher,
} from "@softistx/janus";
import { defineModel, permissions } from "@softistx/janus/permissions";
import type { createMongoAdapter } from "@softistx/janus-mongo";
import { z } from "zod";
import { relationOf, roles } from "../access";

type Store = ReturnType<typeof createMongoAdapter>;

// What an account holds beside what janus sets (id, emailVerified,
// hasPassword, hasSecondFactor…): the e-mail it signs in with, a name for the
// mails and the member lists, and the language its mails are written in.
const Account = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(200),
  locale: z.enum(["en", "fr"]).optional(),
});

export interface AccountsOptions {
  store: Store;
  clock: Clock;
  hasher: PasswordHasher | undefined;
  mail?: MailConfig;
  // The sealing keys of the TOTP secrets, the first seals, every one opens.
  keys: readonly [SealingKey, ...SealingKey[]];
}

// janus with pulsarix's one account type, `user`: a member of any number of
// organisations, global, by e-mail. It signs in with a password or a link sent
// by e-mail, and asks for a TOTP code once the account activated its second
// factor; a session lasts 8 hours and is never renewed.
export function createAccounts(options: AccountsOptions) {
  return janus({
    users: {
      user: {
        schema: Account,
        password: { login: "email" },
        session: { lifespan: "8h", renewAfter: false },
      },
    },
    store: options.store.store,
    relations: options.store.relations,
    hasher: options.hasher ?? scryptHasher(),
    clock: options.clock,
    secondFactor: { issuer: "pulsarix", keys: options.keys },
    ...(options.mail && { mail: options.mail }),
  });
}

export type Accounts = ReturnType<typeof createAccounts>;

// Who is what in an organisation, as janus's relations: one relation per role
// on the `organization` object, named after the role. No permission is read
// from janus for access: the catalogue (src/core/access/catalogue.ts) maps
// roles to permissions.
export function organisationPermissions(
  accounts: Accounts,
  relations: Store["relations"],
) {
  const related = Object.fromEntries(
    roles.map((role) => [relationOf(role), ["user"] as const]),
  ) as Record<string, readonly ["user"]>;
  return permissions({
    model: defineModel({
      subjects: accounts.types,
      types: { organization: { related, permits: {} } },
    }),
    store: relations,
  });
}

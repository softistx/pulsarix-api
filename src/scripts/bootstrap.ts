import { parseArgs } from "node:util";
import { isRole, type Role } from "../core/access";
import { isLocale, type Locale } from "../i18n/locale";
import type { BootstrapInput } from "./bootstrap-organisation";

// The operator's bootstrap command, run in the api container:
//
//   bun dist/scripts/bootstrap.js --organisation "Acme" --invite ada@acme.test \
//     --name "Ada Lovelace" [--slug acme] [--role owner|admin|member|viewer] [--locale en|fr]
//
// Provisions the organisation with no account (SYSTEM_ACTOR) and mails an
// invitation; accepting it creates the account. Safe to run again: an existing
// organisation is reused and the address's pending invitation is replaced.

export const usage =
  "usage: bun dist/scripts/bootstrap.js --organisation <name> --invite <email> --name <name> [--slug <slug>] [--role owner|admin|member|viewer] [--locale en|fr]";

export function parseBootstrapArgs(argv: string[]): BootstrapInput {
  const { values } = parseArgs({
    args: argv,
    options: {
      organisation: { type: "string" },
      slug: { type: "string" },
      invite: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "owner" },
      locale: { type: "string", default: "en" },
    },
    strict: true,
  });
  const missing = (["organisation", "invite", "name"] as const).filter(
    (key) => !values[key]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `missing ${missing.map((k) => `--${k}`).join(", ")}\n${usage}`,
    );
  }
  const role = values.role as string;
  if (!isRole(role))
    throw new Error(`--role "${role}" is not a role\n${usage}`);
  const locale = values.locale as string;
  if (!isLocale(locale))
    throw new Error(`--locale "${locale}" is not en or fr\n${usage}`);
  const email = (values.invite as string).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`--invite "${email}" is not an e-mail address`);
  }
  return {
    organisation: values.organisation as string,
    slug: values.slug,
    email,
    name: values.name as string,
    role: role as Role,
    locale: locale as Locale,
  };
}

async function main() {
  const input = parseBootstrapArgs(Bun.argv.slice(2));
  // Imported here: the config modules open their connections on import.
  const { closeDatabases, coreMongo, tenancy } = await import("../config/db");
  const { serverAuth } = await import("../config/auth");
  const { bootstrapOrganisation } = await import("./bootstrap-organisation");
  try {
    const { organisation, invitation, created } = await bootstrapOrganisation(
      { core: coreMongo, tenancy, auth: serverAuth() },
      input,
    );
    console.log(
      `organisation ${organisation.slug} (${organisation._id.toHexString()}) ${created ? "created" : "reused"}; ${invitation.role} invitation mailed to ${invitation.email}`,
    );
  } finally {
    await closeDatabases();
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

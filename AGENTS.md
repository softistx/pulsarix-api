# pulsarix-api: rules for agents and contributors

The GraphQL API of pulsarix. Conventions are those of operix-api (`~/workspace/dev/operix/operix-api/AGENTS.md`):
Bun, alxia, graxia (via @softistx/alxia-graphql), `@softistx/*` infrastructure packages (plan Q1), a database per
organisation through `@softistx/alxia-tenancy` (A1), English as the default language (Q14). The
owner's rules for every repository are in `~/.claude/CLAUDE.md`; the product's are in
`~/workspace/dev/pulsarix/AGENTS.md`; the plan is `~/workspace/dev/pulsarix/docs/plan.md`.
This file states only what is pulsarix-api's own.

- `src/core/` is the kernel and depends on no business module; `src/modules/registry.ts` is
  the ONE list of modules.
- `bun run verify` is the green bar; `typecheck` is `bun check`.
- The dev services use ports 27018, 6380, 1026/8026 and 9002/9003 so they run beside operix-api's.
- A gap in an in-house package is filed on that package, never worked around.
- Error texts (`src/i18n/texts.ts`, English and French) live in code, not in core-database
  migrations as operix's D9/D10 have them: a deliberate departure: the texts change with the
  code that raises them.
- **Data migrations only grow** (alxia skill §14, plan §20.3). `src/core/migrations/index.ts`
  is the list in execution order, one `<id>.migration.ts` per entry (`defineMigration` of
  `@softistx/mongo/migrations`, id `YYYY-MM-DD-<slug>`), applied to every organisation database
  and recorded there (`nxgt_migrations`): by `provision` when an organisation is created, and by
  `migrateAtBoot` (`src/config/migrate-at-boot.ts`) before the API listens, under the library's
  lock. A migration is appended at the end; a merged one is never edited, reordered or removed
  (a fix is a new migration). It imports nothing from `src/modules/` (models evolve) and writes
  through the driver, past the validator when it moves the previous shape. Each has a spec:
  the cases, a second run changing nothing, a typed record untouched.

## Modules

A module is a folder `src/modules/<name>/`, its files named `<name>.<role>.ts` (the alxia layout of
schoolz-api's AGENTS.md "Modules"). `src/core/` follows it too.

| File                                                                                      | Holds                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<name>.graphqls`                                                                         | the module's SDL                                                                                                                                                         |
| `<name>.model.ts`                                                                         | the `@softistx/mongo` collection: Zod schema, indexes, stamps                                                                                                            |
| `graphql/` (intake)                                                                       | the SDL and, for a public endpoint, its typedefs, persisted operations and schema (imported by file, no barrel)                                                          |
| `<name>.service.ts` (`services/` when several)                                            | the business rules; with the data-loaders, the only code that reads or writes a model                                                                                    |
| `<name>.resolver.ts` (`resolvers/` when several)                                          | thin: guard, then call the service                                                                                                                                       |
| `<name>.data-loader.ts` (`data-loaders/` when several)                                    | the module's DataLoaders (A8 adds them), each with its spec                                                                                                              |
| `<name>.errors.ts`                                                                        | its refusals and its codes                                                                                                                                               |
| `<name>.utils.ts` (`utils/` when several, with a barrel)                                  | its helper functions: not a business rule, no collection access                                                                                                          |
| `<name>.rules.ts`                                                                         | its pure rules: input checks and computations, no storage                                                                                                                |
| `<name>.archived.ts`, `.usage.ts`, `.lock.ts`, `.query.ts`, `.validation.ts`, `.kinds.ts` | pulsarix's own roles: what an archive refuses, the usage counts, the lock documents, the query builders, the input checks, the kinds a module declares                   |
| `<name>.resolver-support.ts`, `<name>.store.ts`, `<name>.integrity.ts`                    | what a resolver shares (the guard-then-services call), the port to an external store (the S3 bucket), and the cleanup a change of another record triggers (stored files) |
| `<name>.routes.ts` (`routes/` when several), `<name>.http.ts`                             | the REST routes of the transport below, and their paths and shared HTTP pieces                                                                                           |
| `module.ts`                                                                               | the `defineModule` declaration the registry lists                                                                                                                        |
| `public.ts`                                                                               | what other modules may import from this one (the only entry point across modules)                                                                                        |
- **Flat or folders**: a role with one file stays flat at the module's root; once it has several
  files they go in a folder named after the role, with an `index.ts` barrel.
  Inside a module imports are relative; `@/…` is for other modules.
- **Sizes**: a file stays under 250 lines, a function under 80, a service method under 50.
  Past it, split by concern.
- **No helper function at the top level of a service, a resolver or a data-loader**: such a file
  holds its role; a small helper goes to the module's `<name>.utils.ts` (or rules, errors) with
  its spec. What stays is what reads or writes a model. Top-level `const` data may stay.
- **Never `== null` or `!= null`**: test `=== undefined` or `=== null` as the type says.
- **A helper used by several modules** goes to `src/core/shared` and is never copied.
- **Specs** (plan decision D1): a module's specs are GraphQL specs through the app, placed beside their service
  as `services/<x>.service.spec.ts` (`<name>.service.spec.ts` when flat). No unit spec is
  required for a service; rules, utils and data-loaders keep their own specs.

## Transport

- GraphQL on `/graphql` is the team's transport. The widget's public surface is
  `/public/graphql` plus these `/public/*` routes, the only others: `/public/media/report-files`,
  `/public/live/requests`, `/public/tracking/files`, `/public/requests/files` and
  `/public/unsubscribe` (intake). Other than the `@softistx/alxia-media` routes under `/media/*`, any REST route is a departure to argue in the PR.
- Media goes through `@softistx/alxia-media`: keys in the schema, files over a private bucket.
- `Attachment.url` and `ClientReportFile.url` are deliberate same-origin `/media/<kind>/<key>`
  paths served by the API, not bucket URLs (plan decision D4).

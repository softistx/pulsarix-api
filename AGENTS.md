# pulsarix-api: rules for agents and contributors

The GraphQL API of pulsarix. Conventions are those of operix-api (`~/workspace/dev/operix/operix-api/AGENTS.md`):
Bun, alxia, graxia (via @alxia/graphql), `@softistx/*` infrastructure packages (plan Q1), a database per
organisation through `@alxia/tenancy` (A1), English as the default language (Q14). The
owner's rules for every repository are in `~/.claude/CLAUDE.md`; the product's are in
`~/workspace/dev/pulsarix/AGENTS.md`; the plan is `~/workspace/dev/pulsarix/docs/plan.md`.
This file states only what is pulsarix-api's own.
- `src/core/` is the kernel and depends on no business module; `src/modules/registry.ts` is
  the ONE list of modules.
- `bun run verify` is the green bar; `typecheck` is `bun check`.
- The dev services use ports 27018, 6380, 1026/8026 and 9002/9003 so they run beside operix-api's.
- A gap in an in-house package is filed on that package, never worked around.
- Error texts (`src/i18n/texts.ts`, English and French) live in code, not in core-database
  migrations as operix's D9/D10 have them: a deliberate departure. There is no migrations
  framework in v1, and the texts change with the code that raises them.

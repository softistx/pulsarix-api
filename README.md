# pulsarix-api

The GraphQL API of pulsarix: organisations, members, projects, issues, comments,
activity, notifications, attachments, search, realtime subscriptions and client
intake (widget keys and the public intake endpoint).

Stack: Bun, `@alxia/*`, GraphQL Yoga, `@softistx/mongo`, `@softistx/janus`,
`@softistx/redis`, `@softistx/s3`, `@softistx/mail`. Conventions follow operix-api.
The plan is [../docs/plan.md](../docs/plan.md) (slices A0 to A10); the vocabulary is
[CONTEXT.md](CONTEXT.md).

## Running

- `cp .env.example .env`, then `bun run dev`: starts the Docker services (Mongo replica set,
  Redis, Mailpit, MinIO) and the API in watch mode. `bun run dev:api` is the API alone;
  `bun run services:down` stops the services.
- `GET /health` and `GET /ready` are the probes; `POST /graphql` is the one entry point.
- `bun run schema:print` writes `schema.graphql`, the committed contract the UI generates
  its client from.

## Checks

`bun run verify` is the green bar: generate, `schema:print --check`, `biome ci`,
`context:check`, `bun check`, `bun test`, production build. CI runs it on pull requests
into `develop` and `feat/v1`. Layout: `src/core/` (kernel), `src/modules/` (business
modules, listed only in `src/modules/registry.ts`).

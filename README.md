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
- Every `/graphql` request carries `x-pulsarix-client` (any value); a request about an
  organisation names it in `x-organization-id` (its id or slug) and the session token in
  `Authorization: Bearer`. The operations: sign-up, sign-in, second factor (TOTP), magic link (behind `PULSARIX_MAGIC_LINK`, off by default; `authConfig { magicLink }` tells the UI),
  reset, `createOrganisation`, members, invitations, step-up (see `schema.graphql` and the
  error codes in [CONTEXT.md](CONTEXT.md)). Texts are English by default, French with
  `Accept-Language: fr`.
- `GET /health` and `GET /ready` are the probes; `POST /graphql` is the one entry point.
- `POST /public/graphql` is the widget's endpoint (and the tracking page's): three persisted
  operations, CORS per widget key, rate limits in Redis (503 without it), see "Public endpoint" in
  [CONTEXT.md](CONTEXT.md). Behind a proxy set `TRUSTED_PROXIES`, or every client shares one address.
- `bun run schema:print` writes `schema.graphql`, the committed contract the UI generates
  its client from.

## Deployment

`docs/deployment.md` is the runbook: the staging stack in `deploy/` (compose, `deploy.ts` with a
`--dry-run`, nightly backups, restore and drill) and the API `Dockerfile`.

## Checks

`bun run verify` is the green bar: generate, `schema:print --check`, `biome ci`,
`context:check`, `bun check`, `bun test`, production build. The specs need no Docker: they
start an in-memory MongoDB replica set (`test/setup.ts`). CI runs `bun run verify:pr` (the same steps, with only the specs a diff affects) on pull
requests into `develop`. Layout: `src/core/` (kernel), `src/modules/` (business
modules, listed only in `src/modules/registry.ts`).

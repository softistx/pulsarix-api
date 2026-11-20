# pulsarix-api

The GraphQL API of pulsarix: organisations, members, projects, issues, comments,
activity, notifications, attachments, search, realtime subscriptions and client
intake (widget keys and the public intake endpoint).

Stack: Bun, `@alxia/*`, graxia (via @alxia/graphql), `@softistx/mongo`, `@softistx/janus`,
`@softistx/redis`, `@softistx/s3`, `@softistx/mail`. Conventions follow operix-api.
The plan is [../docs/plan.md](../docs/plan.md) (slices A0 to A10); the vocabulary is
[CONTEXT.md](CONTEXT.md).

## Running

- `cp .env.example .env`, then `bun run dev`: starts the Docker services (Mongo replica set,
  Redis, Mailpit, MinIO) and the API in watch mode. `bun run dev:api` is the API alone;
  `bun run services:down` stops the services.
- Every `/graphql` request carries `x-pulsarix-client` (any value); a request about an
  organisation names it in `x-organization-id` (its id or slug) and the session token in
  `Authorization: Bearer`. The operations: sign-up, sign-in, e-mail verification (`requestEmailVerification`, `confirmEmailVerification`; `Viewer.emailVerified`), second factor (TOTP), magic link (behind `PULSARIX_MAGIC_LINK`, off by default; `authConfig { magicLink }` tells the UI),
  reset, `createOrganisation`, members, invitations, step-up (see `schema.graphql` and the
  error codes in [CONTEXT.md](CONTEXT.md)). Texts are English by default, French with
  `Accept-Language: fr`.
- `signUp` and `acceptInvitation` are limited per client address in Redis (10 and 20 an hour;
  429 `auth.errors.too-many-attempts`, whose extensions carry `reason: "throttled"`, `retryAfter` and `minutes`; 503 if Redis cannot be asked; no limit without Redis).
  `requestEmailVerification` is limited per account in Redis (10 an hour, same answers; janus adds 5 per 10
  minutes per address).
  Behind a proxy set `TRUSTED_PROXIES`, or every client shares one address.
- Locally, get a session token with `signUp` (or `signIn`), then send it as
  `Authorization: Bearer <token>` with `x-pulsarix-client: dev`:

  ```sh
  curl -s localhost:3000/graphql -H 'content-type: application/json' -H 'x-pulsarix-client: dev' \
    -d '{"query":"mutation($i: SignUpInput!){ signUp(input:$i){ session{ token } } }","variables":{"i":{"email":"me@pulsarix.test","password":"a long password","name":"Me"}}}'
  ```

  Without `MAIL_URL` mails are printed to the API's console (`[mail] to ...`) and `bun run dev:api`
  (NODE_ENV=development) shows the links' `?token=` values there; elsewhere they print as
  `[redacted]`. Copy the token of an invitation, reset or magic-link mail from that output into
  the matching mutation. With `MAIL_URL=smtp://localhost:1026`, read them in Mailpit
  (http://localhost:8026) instead.
- `GET /health` and `GET /ready` are the probes; `POST /graphql` is the one entry point.
- `POST /public/graphql` is the widget's endpoint (and the tracking page's): three persisted
  operations, CORS per widget key, rate limits in Redis (503 without it), see "Public endpoint" in
  [CONTEXT.md](CONTEXT.md). Behind a proxy set `TRUSTED_PROXIES`, or every client shares one address.
- `GET /media/report-files/<key>/<full|file|256>` is the team's read of a report file (UI server: `x-pulsarix-client`, a session, `attachment:read`; a quarantined file also needs `issue:write`, else 404).
- `GET /public/tracking/files/<id>` is the reporter's thumbnail (UI server only: `x-pulsarix-client` and the token in `x-pulsarix-tracking`; refused when the request has an `Origin`). Keep both off the public proxy.
- The identified reporter's requests (A17), all behind the `x-pulsarix-identity` token and CORS per key: persisted operations on `/public/graphql` (`myRequests`, `request`, `replyToRequest`, `resolveRequest`, `reopenRequest`, `markRequestRead`, `setRequestEmails`, `eraseMyData` (once an hour per reporter, spent only once the erasure succeeded), each with the `publicKey` variable), `GET /public/requests/files/<id>?key=<publicKey>` (a thumbnail) and `GET /public/live/requests?key=<publicKey>` (server-sent events read with `fetch`: `unread {count}`, `request.updated {id, publicState, unread}`, `expired {}`, then the stream ends; at most 3 open per reporter; it closes with `expired {}` when the token expires or, checked every 30 s, when the key is revoked or disabled or its identity secret rotated; a reply edited, withdrawn or deleted is announced too). These are for browsers: unlike the tracking reads, they may go through the public proxy, which must not buffer `text/event-stream`.
- The tracking page's actions (A18), for the UI server only (no `Origin`, `x-pulsarix-client` required; the token is the `x-pulsarix-tracking` header, never the URL): `clientReportStatus` (now with `id`, `description`, `impact`, `type`, `thread`, `canReply`, `canReopen`, `resolvedAt`, `emailsOn`; the `token` variable still works), `trackingReply` (`input {body, files}`; its file tickets are PUT by the UI server to `/public/media/report-files/<slot>` with `x-pulsarix-ticket` and `x-pulsarix-client`, no `Origin`), `trackingResolve`, `trackingReopen`, `trackingErase` (this request only; its token is unknown afterwards), `trackingEmails(on)`. They run the services of A17, so the rules are the same; they share the tracking read limit of the address, and a foreign or erased token is the one 404.
- The reporter's e-mail (A19), the queue `intakeReporterMail`: a team reply or a change of the request's public state queues one job per report, which sends one e-mail after a 10-minute window, so three replies in ten minutes are one mail. An identified reporter reads the replies in the mail and lands on the page they filed from, linked only when its origin is one of the key's allowed origins; an unidentified one gets the tracking link. An identified report is mailed only to the address its identity token vouches for (the form's address is ignored; a token without an `email` claim means no mail). Each mail carries an unsubscribe link, `GET|POST /public/unsubscribe/<org>.<report>.<mac>`, served on the UI hostname through Traefik's `/public/` rule (one click sets `emailsOff` on every request of that reporter under the key); the `List-Unsubscribe` header is sent only when the UI origin is https. The link's secret is derived from `INTAKE_TICKET_SECRET` (else from `API_PROXY_SECRET`): rotating it voids the links already sent.
- `bun run schema:print` writes `schema.graphql`, the committed contract the UI generates
  its client from.

## Deployment

`docs/deployment.md` is the runbook: the staging stack in `deploy/` (compose, `deploy.ts` with a
`--dry-run`, nightly backups, restore and drill) and the API `Dockerfile`. The widget is deployed with
`bun deploy/deploy.ts --widget` (in place, no restart, no 404 window).

## Checks

`bun run verify` is the green bar: generate, `schema:print --check`, `biome ci`,
`context:check`, `bun check`, `bun test`, production build. The specs need no Docker: they
start an in-memory MongoDB replica set (`test/setup.ts`). CI runs `bun run verify:pr` (the same steps, with only the specs a diff affects) on pull
requests into `develop`. Layout: `src/core/` (kernel), `src/modules/` (business
modules, listed only in `src/modules/registry.ts`).

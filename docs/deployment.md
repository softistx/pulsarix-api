# Deployment

The staging stack of pulsarix-api, after operix-api's `deploy/`. Everything lives in `deploy/`
plus the `Dockerfile` at the root. Images are built on the host from the checkouts (no
registry).

## What runs

| Service               | Image                        | Role                                                                                                                                                           |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongo`               | `mongo:8.0`                  | one-node replica set, auth on (keyfile from `MONGO_KEYFILE`)                                                                                                   |
| `mongo-init`          | `mongo:8.0`                  | one-shot: the app user, and the backup user when `MONGO_BACKUP_PASSWORD` is set (re-applied on every `up`)                                                     |
| `redis`               | `redis:7.4`                  | password, append-only. **Required**: rate limits, the digest and report-files retention queues, live events; the public intake endpoint answers 503 without it |
| `minio`, `minio-init` | Chainguard, pinned by digest | attachments bucket and the API's own limited user                                                                                                              |
| `backup`              | `deploy/backup/Dockerfile`   | profile `backup`, started with `--backup`: nightly `mongodump --oplog`, offsite copy, media mirror                                                             |
| `api`                 | root `Dockerfile`            | the GraphQL API, port 3000, on the stack network and on `proxy`                                                                                                |
| `ui`                  | `../../pulsarix-ui`          | profile `ui`, started with `--ui`;                                serves the widget's `dist` (see "The widget bundle")                                         |

No service publishes a port. Two networks: `internal`, private to the stack, holds every service;
the external `proxy` network (nxgt-docker creates it) holds only `api` and `ui` as well, so Traefik
reaches them by container name. `mongo`, `redis`, `minio` and `backup` (when enabled) are on `internal` only:
another stack on `proxy` cannot reach them. This isolates the data services from the parc's other
stacks, not from the API itself, and `api` stays reachable by any container on `proxy`. In
development (`docker-compose.yml`) the published ports are bound to `127.0.0.1`.

## Routing and the client address

One public hostname, `UI_HOSTNAME` (`pulsarix.softistx.com`). Traffic comes visitor, Cloudflare
(tunnel), cloudflared, Traefik, app. The proxied `*.softistx.com` wildcard already covers the
name: **never add a DNS record**. The API's router takes `Host(UI_HOSTNAME) && PathPrefix(/public/)`
(the widget's intake endpoint, priority 100); the UI's router takes the rest. `/graphql` has no
router: the UI's server calls it by container name.

`TRUSTED_PROXIES=172.16.0.0/12` (the docker range) makes the API read the client address from
`X-Forwarded-For` past Traefik only. It drives the intake rate limits, the anti-abuse checks and
the auth audit, and is required in production (the API refuses to start without it, so the
per-address limits never key on the UI container's address). A range or addresses only: a hop count stops the API at startup. Never the
`cloudflare` keyword, `X-Real-Ip` or `CF-Connecting-IP`.

`API_PROXY_SECRET` (required: `openssl rand -hex 32`, at least 32 characters) is set on both the
`ui` and the `api` service from the same variable. The UI sends it as `x-pulsarix-proxy-secret`.
For `/graphql` (and the media routes) the API honours the forwarded client address only on a
request that carries it (constant-time compare); any other request gets the connection's address.
`/public/` is exempt: the widget's browsers call it through Traefik, which cannot add the secret,
so it keeps `TRUSTED_PROXIES` alone, or every visitor would share Traefik's address and one rate
limit. Unset in development, only `TRUSTED_PROXIES` decides.

`INTAKE_TICKET_SECRET` (optional, at least 32 characters) signs the widget's upload tickets. Unset,
the key is derived from `API_PROXY_SECRET`, so a deployment needs nothing more; set it to rotate
tickets apart from the proxy secret (tickets last 15 minutes, so a rotation costs at most the files
in flight). The widget's `PUT /public/media/report-files/<slot>` goes through Traefik like the
rest of `/public/`. The unsubscribe links of the reporters' e-mails derive from the same secret:
rotating it also voids the links already sent.
The report-file reads (`GET /media/report-files/...`, `GET /public/tracking/files/...`) are for the UI server only: do not route them from the public proxy.

## Queues

The Redis queues (`src/config/queues.ts`) are worked by the API process; the schedules fire only
while a worker runs, and every job is safe to repeat. The intake ones: `intake-retention` (nightly
03:30 UTC, erases the e-mail of reports settled 90 days ago), `intake-files-retention` (every 5
minutes, purges expired file slots and the files of declined or untriaged reports) and
`intake-reporter-mail` (the reporters' e-mails: one delayed job per report, 10 minutes after the
first change, so replies in a window are one mail; at least once, never lost). The mail job needs
`MAIL_FROM` and `UI_ORIGIN`, the latter being the host of the unsubscribe links (the
`List-Unsubscribe` header is sent only when it is https). With one API container only, the live
stream's per-reporter cap is also exact (it counts per process).
The sprints one: `sprint-snapshots` (every 15 minutes, takes the snapshot of the day that just ended
for each active sprint of each organisation whose midnight has passed, if it is not there yet: the
burndown's daily point; a missed run is made up by the next).

## The API image

Bun 1.4.4 (the version CI uses), **glibc** (`oven/bun:1.4.4-slim`, Debian), linux x64 and arm64.
The bundle (`dist/server.js`) leaves `@napi-rs/canvas` and `pdfjs-dist` external (the PDF
renderer resolves `pdfjs-dist` at run time for its fonts); the image installs just those two,
at the lockfile's versions, for its own platform. `@softistx/image/pdf` needs its native
Skia binary for the first-page previews of PDF attachments. glibc was chosen because it is the
most exercised build of the binary; the musl builds exist and Alpine is a one-line change, guarded
by the same check.

The check: `src/scripts/pdf-preview-check.ts` renders a tiny PDF through `renderPdfFirstPage`.
The Dockerfile runs it in the final image (`RUN bun --no-install dist/scripts/pdf-preview-check.js`),
so a missing or wrong-libc binary fails `docker build`, not the first upload. A spec runs the same
check on the host.

## The widget bundle

The UI serves the widget at `/widget/v1/*` from `WIDGET_DIST_DIR`; in production without it the
route is 404. The compose file sets `WIDGET_DIST_DIR=/widget` on `ui` and bind-mounts pulsarix-widget's
built `dist` there, read only, from `WIDGET_DIST` (default `../../pulsarix-widget/dist`, relative to
`deploy/`). So the widget is not in the UI image: build it on the host before `up --ui`
(`bun run build` in `pulsarix-widget`), and a new widget build needs no UI rebuild. Deploy a new widget
with `bun deploy/deploy.ts --widget` (`--dry-run` first): it pulls and installs the widget checkout, builds in a
scratch copy, copies the files into the served `dist` in place (loader and manifest last, the previous
bundle kept one deploy) and checks `/widget/v1/loader.js` through the container. Never run `bun run build`
in the checkout by hand on a running stack: it recreates `dist`, the mount goes stale and the app answers
404 (cached by Cloudflare) until `docker restart pulsarix-ui`. A missing
folder fails `up` (the mount never creates it empty). Traefik already sends every path but `/public/`
to the UI, so no router changes.

## Migrations

There is no migration script; the schema is synced in two places, and the data migrations
(`src/core/migrations`) run on every organisation database at boot.

- **Data migrations at every boot.** `src/server.ts` calls `migrateAtBoot`
  (`src/config/migrate-at-boot.ts`) after the core sync and before the API listens:
  `tenancy.migrateTenants`, which syncs then migrates each organisation database under the
  library's lock and records each id in the database's `nxgt_migrations`. Every organisation is
  visited; any failure is logged with its database and the process exits 1, so the container never
  turns healthy over a half-migrated organisation. A new organisation is migrated by `provision`.
  The migrations only grow (AGENTS.md); the first, `2026-11-21-issue-types`, types the issues
  stored before the types (Task, Bug by a "Bug" label, Sub-task by a parent).

- **The core database at every boot.** `src/server.ts` calls `syncCoreAtBoot`
  (`src/config/core-sync.ts`) before the API listens: `coreMongo.sync()` (the
  organisation registry, locks, invitations) and janus-mongo's `syncMongoAdapter`
  (users, sessions, tokens, relations). So a new janus-mongo validator or index
  reaches production with the next deploy, no step to remember. It is
  idempotent (`collMod` and `createIndexes`; an index is rebuilt only when its
  options changed, nothing else is dropped, no document is touched) and cheap
  (a handful of collections, no loop over organisations). A failure is logged
  (`core database sync failed, not starting`) and the process exits 1, so the
  container never turns healthy on a stale schema. The log line
  `core database validators and indexes synced` confirms it.
- **Each organisation database on first use.** Each organisation has its own
  database, created at runtime, so the boot sync cannot cover them. The API runs
  with `MONGO_AUTO_SYNC=true` (declared in `src/config/env.ts`: `1`, `true`,
  `yes` or `on`; off in production when unset; the compose file sets it):
  validators and indexes are created on first use. For that the app user holds
  `readWriteAnyDatabase` and `dbAdminAnyDatabase` (the backup user holds `backup`
  only). `tenancy.sync()` is not called at boot; `migrateAtBoot` visits every organisation
  database anyway (it syncs each one before migrating it). A collection option MongoDB
  cannot change in place makes the boot sync throw: the API then exits 1 until it is fixed by hand.
  The dashboard query adds two `issues` indexes (`issues_projectIdStatusIdPriorityDue`,
  `issues_assigneeIdStatusId`): each organisation builds them on its first request after the
  deploy, no step to run.

## First deploy

```sh
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env   # fill every CHANGE_ME
bun deploy/deploy.ts --dry-run          # the plan, and what the env file still lacks
bun deploy/deploy.ts                    # pull, build, up --wait
```

`--dry-run` pulls, builds and starts nothing and opens no connection; it exits
1 when the env file has problems, so it is also the preflight. The build needs no registry token (the
@softistx packages come from npmjs). Flags: `--env`, `--prefix` (a second stack), `--no-pull`, `--ui`,
`--backup` (see "Backups"), `--timeout`. Without `--backup` the deploy prints one line saying the
backup is off. A rerun with nothing changed recreates nothing.

Every container is capped (`deploy.resources.limits`: mongo and api 1 cpu / 1G, ui, minio and
backup 0.5 / 512M, redis 0.25 / 256M, one-shots 0.25 / 256M) because the host caps the VPS CPU.
Healthchecks run every 30 s (a bash TCP probe for mongo, `redis-cli ping`, a bash HTTP probe for
the api, `wget` for the ui), never `mongosh` or `bun -e`; `mongo-init` initiates the replica set
and waits for its primary. Once the stack is healthy, `deploy.ts` runs `docker image prune -f`,
removes this app's previous image tags (never another product's, never one in use) and runs
`docker builder prune -f --filter until=24h`; `--widget` builds no image and prunes nothing.

Sign-in by an e-mailed link is off unless `PULSARIX_MAGIC_LINK=true` in `deploy/.env`.

Check: `docker compose -f deploy/docker-compose.yaml --env-file deploy/.env ps` shows every
service healthy; `GET /ready` answers 200 inside the API container.

## First organisation (bootstrap)

A fresh deployment has no organisation and no account. The operator makes the first one with
`dist/scripts/bootstrap.js`, built by `bun run build:scripts` and shipped in the image. It provisions
the organisation with no account (stamped `SYSTEM_ACTOR`) and mails an invitation, with the role
(`owner` by default) to its first member; accepting the link creates the account.

```sh
docker compose -f deploy/docker-compose.yaml --env-file deploy/.env exec api \
  bun --no-install dist/scripts/bootstrap.js \
  --organisation "Acme" --invite ada@acme.test --name "Ada Lovelace" [--slug acme] [--role owner|admin|member|viewer] [--locale en|fr]
```

It reads the api container's own environment (Mongo, mail, `UI_ORIGIN`). Safe to run again: an
organisation whose slug exists is reused (it must be `active`) and the address's pending
invitation is replaced, so the same line re-sends a lost mail or finishes a run that failed after the organisation was made. An address that is already a member is refused. The logic is
`bootstrapOrganisation` (`src/scripts/bootstrap-organisation.ts`), sharing
`provisionOrganisation` with the `createOrganisation` service.

## Backups

The offsite backup is **opt-in**: the `backup` service is in the compose profile `backup`, so a
plain `bun deploy/deploy.ts` neither builds nor starts it, and `BACKUP_S3_*` and
`MONGO_BACKUP_PASSWORD` are not required (the deploy prints "backup off"). Enable it later with
`bun deploy/deploy.ts --backup`: it then requires the four `BACKUP_S3_*` settings and
`MONGO_BACKUP_PASSWORD` (checked before anything is built), builds the backup image and starts the
service. `mongo-init` creates the backup user only when `MONGO_BACKUP_PASSWORD` is set. Until the
backup is on, there is no offsite copy and `restore.ts` / `restore-drill.ts` (which run inside the
`backup` container) are unavailable.

A stack that once ran with `--backup` and is redeployed without it keeps the old backup container;
stop it with `docker compose --profile backup stop backup`.

When enabled, the `backup` service dumps the whole Mongo instance with its oplog (one consistent moment) every
night at `BACKUP_HOUR` (UTC) to the `backup-data` volume, copies the dump and a mirror of the
media bucket offsite (`BACKUP_S3_*`, any S3-compatible bucket), keeps `BACKUP_RETENTION_DAYS`
days locally, and mails `BACKUP_ALERT_TO` when a run fails or none succeeded for 26 h. Its
healthcheck turns unhealthy at 26 h. The offsite key writes and reads only: it cannot delete or
create a bucket, so a leaked key cannot erase the backups. The 14-day offsite retention is an
expiry rule set once on the bucket.

### Offsite bucket, one-time setup

Create a private bucket at the provider, a key limited to it (read and write objects, list), and
an expiry rule of 14 days. Put the endpoint, bucket and key in `deploy/.env` (`BACKUP_S3_*`), then deploy with `--backup`.

## Restore and drill

```sh
bun deploy/restore-drill.ts                      # proves the latest dump restores, into scratch databases
bun deploy/restore.ts --yes --confirm default    # DROPS and restores the collections the dump holds
```

The drill restores the latest dump into `drill_<timestamp>_*` databases, compares their
collections with the ones the code defines (`src/modules/registry.ts`), checks that no project's
`issueCounters` entry is behind its highest issue number (a counter kept apart from the issues; a
counter behind would make the next issue collide on `(projectId, number)`; `deploy/numbering.ts`),
prints PASS or FAIL and drops the scratch databases. It never touches live data. Run it after the first deploy and then
monthly. `restore.ts` needs `--yes` and `--confirm <prefix|default>` naming the stack; stop `api`
first when writes may land meanwhile. Options: `--file`, `--from-prefix` (another stack's offsite
folder), `--database`. The Mongo users are not restored: `mongo-init` recreates them on `up`.

## Rollback

`git checkout <good commit>` in the API checkout, then `bun deploy/deploy.ts --no-pull`. Data
changes are additive (auto sync never drops); a data rollback is a restore.

## Not done yet

The offsite backup: no bucket is configured on staging yet. Set `BACKUP_S3_*` and `MONGO_BACKUP_PASSWORD` in `deploy/.env`, then run `bun deploy/deploy.ts --ui --backup`. The restore drill (`bun deploy/restore-drill.ts`) needs the backup service, so it waits for that.

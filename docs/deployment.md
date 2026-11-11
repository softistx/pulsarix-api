# Deployment

The staging stack of pulsarix-api, after operix-api's `deploy/`. Everything lives in `deploy/`
plus the `Dockerfile` at the root. Images are built on the host from the checkouts (no
registry).

## What runs

| Service               | Image                        | Role                                                                                                                               |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mongo`               | `mongo:8.0`                  | one-node replica set, auth on (keyfile from `MONGO_KEYFILE`)                                                                       |
| `mongo-init`          | `mongo:8.0`                  | one-shot: the app user and the backup user (re-applied on every `up`)                                                              |
| `redis`               | `redis:7.4`                  | password, append-only. **Required**: rate limits, the digest queue, live events; the public intake endpoint answers 503 without it |
| `minio`, `minio-init` | Chainguard, pinned by digest | attachments bucket and the API's own limited user                                                                                  |
| `backup`              | `deploy/backup/Dockerfile`   | nightly `mongodump --oplog`, offsite copy, media mirror                                                                            |
| `api`                 | root `Dockerfile`            | the GraphQL API, port 3000 on the `proxy` network only                                                                             |
| `ui`                  | `../../pulsarix-ui`          | profile `ui`, started with `--ui` once pulsarix-ui has its Dockerfile                                                              |

No service publishes a port. Traefik reaches `api` (and `ui`) by container name on the external
`proxy` network, which nxgt-docker creates.

## Routing and the client address

One public hostname, `UI_HOSTNAME` (`pulsarix.softistx.com`). Traffic comes visitor, Cloudflare
(tunnel), cloudflared, Traefik, app. The proxied `*.softistx.com` wildcard already covers the
name: **never add a DNS record**. The API's router takes `Host(UI_HOSTNAME) && PathPrefix(/public/)`
(the widget's intake endpoint, priority 100); the UI's router takes the rest. `/graphql` has no
router: the UI's server calls it by container name.

`TRUSTED_PROXIES=172.16.0.0/12` (the docker range) makes the API read the client address from
`X-Forwarded-For` past Traefik only. It drives the intake rate limits, the anti-abuse checks and
the auth audit. A range or addresses only: a hop count stops the API at startup. Never the
`cloudflare` keyword, `X-Real-Ip` or `CF-Connecting-IP`.

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

## Migrations

There is no migration step. Each organisation has its own database, created at runtime, so no
deploy step can sync them. The API runs with `MONGO_AUTO_SYNC=true` (exactly `true`; the compose file sets it): validators and indexes are
created on first use. For that the app user holds `readWriteAnyDatabase` and `dbAdminAnyDatabase`
(the backup user holds `backup` only).

## First deploy

```sh
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env   # fill every CHANGE_ME
bun deploy/deploy.ts --dry-run          # the plan, and what the env file still lacks
bun deploy/deploy.ts                    # pull, build, up --wait
```

`--dry-run` pulls, builds and starts nothing, looks up no token and opens no connection; it exits
1 when the env file has problems, so it is also the preflight. The build needs a GitHub Packages
token with `read:packages` (`$GITHUB_TOKEN`, `~/.config/pulsarix/github-token` or `gh auth token`),
handed to BuildKit as a secret. Flags: `--env`, `--prefix` (a second stack), `--no-pull`, `--ui`,
`--timeout`. A rerun with nothing changed recreates nothing.

Check: `docker compose -f deploy/docker-compose.yaml --env-file deploy/.env ps` shows every
service healthy; `GET /ready` answers 200 inside the API container.

## Backups

The `backup` service dumps the whole Mongo instance with its oplog (one consistent moment) every
night at `BACKUP_HOUR` (UTC) to the `backup-data` volume, copies the dump and a mirror of the
media bucket offsite (`BACKUP_S3_*`, any S3-compatible bucket), keeps `BACKUP_RETENTION_DAYS`
days locally, and mails `BACKUP_ALERT_TO` when a run fails or none succeeded for 26 h. Its
healthcheck turns unhealthy at 26 h. The offsite key writes and reads only: it cannot delete or
create a bucket, so a leaked key cannot erase the backups. The 14-day offsite retention is an
expiry rule set once on the bucket.

### Offsite bucket, one-time setup

Create a private bucket at the provider, a key limited to it (read and write objects, list), and
an expiry rule of 14 days. Put the endpoint, bucket and key in `deploy/.env` (`BACKUP_S3_*`).

## Restore and drill

```sh
bun deploy/restore-drill.ts                      # proves the latest dump restores, into scratch databases
bun deploy/restore.ts --yes --confirm default    # DROPS and restores the collections the dump holds
```

The drill restores the latest dump into `drill_<timestamp>_*` databases, compares their
collections with the ones the code defines (`src/modules/registry.ts`), prints PASS or FAIL and
drops the scratch databases. It never touches live data. Run it after the first deploy and then
monthly. `restore.ts` needs `--yes` and `--confirm <prefix|default>` naming the stack; stop `api`
first when writes may land meanwhile. Options: `--file`, `--from-prefix` (another stack's offsite
folder), `--database`. The Mongo users are not restored: `mongo-init` recreates them on `up`.

## Rollback

`git checkout <good commit>` in the API checkout, then `bun deploy/deploy.ts --no-pull`. Data
changes are additive (auto sync never drops); a data rollback is a restore.

## Not done yet

The real staging deploy (this slice only prepared and dry-ran it), the `restore` check of issue
key counters if a project counter is kept apart from its issues, and the UI image.

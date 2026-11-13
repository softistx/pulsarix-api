#!/usr/bin/env bun
/**
 * Deploys the pulsarix-api staging stack on this machine, by hand and
 * idempotently: git pull the checkout, build the images here (there is no
 * registry), `up --wait` until every service is healthy. A rerun with nothing
 * changed pulls nothing, rebuilds from cache and recreates no container; only
 * the health wait does work. Migrations are not a step: the API creates each
 * database's validators and indexes on first use (MONGO_AUTO_SYNC).
 *
 * The images install the private @softistx/* packages (GitHub Packages): the
 * build needs a token with read:packages, from $GITHUB_TOKEN or
 * ~/.config/pulsarix/github-token, or `gh auth token`, handed to BuildKit as a
 * secret.
 *
 *   bun deploy/deploy.ts [--env deploy/.env] [--prefix staging]
 *                        [--no-pull] [--ui] [--backup] [--timeout 300]
 *                        [--dry-run]
 *
 *   --env      the stack's env file (default deploy/.env); it must exist and be
 *              mode 600, or the script refuses to run
 *   --prefix   STACK_PREFIX, overriding the file (a second stack)
 *   --no-pull  skip `git pull` (a checkout on a feature branch)
 *   --ui       also build and start pulsarix-ui (compose profile `ui`)
 *   --backup   also build and start the offsite backup (compose profile `backup`)
 *              and require its BACKUP_S3_* settings; without it the backup is
 *              off and nothing about it is required
 *   --dry-run  print the plan and what the env file lacks, then stop: no git,
 *              no docker, no network, no token lookup, nothing written. Exit 1
 *              when the env file has problems, so it doubles as a preflight
 *
 * The backup service (nightly dump, offsite copy) is opt-in: with --backup its
 * BACKUP_S3_* settings are checked before anything is built; without it one
 * line says the backup is off. restore.ts and restore-drill.ts bring data back
 * and prove a dump restores.
 */

import { existsSync } from "node:fs";
import { $ } from "bun";
import {
  API_ROOT,
  DEPLOY_DIR,
  fail,
  flagValue,
  GITHUB_TOKEN_FILE,
  githubToken,
  loadStack,
  parseEnv,
  resolvePrefix,
  uiContext,
} from "./lib";
import { BACKUP_OFF_LINE, deploySteps, envProblems, renderPlan } from "./plan";

const args = Bun.argv.slice(2);
const known = new Set([
  "--env",
  "--prefix",
  "--no-pull",
  "--ui",
  "--backup",
  "--timeout",
  "--dry-run",
]);
for (const a of args) {
  if (a.startsWith("--") && !known.has(a)) fail(`unknown flag ${a}`);
}

const timeout = flagValue(args, "--timeout") ?? "300";
if (!/^[1-9][0-9]*$/.test(timeout)) fail("--timeout is a number of seconds");
const options = {
  noPull: args.includes("--no-pull"),
  ui: args.includes("--ui"),
  backup: args.includes("--backup"),
  timeout,
};
const step = (name: string, detail = "") =>
  console.log(`  ${name.padEnd(9)} ${detail}`);

if (args.includes("--dry-run")) {
  // Local reads only: the env file, if there is one. Nothing is spawned.
  const envFile = flagValue(args, "--env") ?? `${DEPLOY_DIR}/.env`;
  const values = existsSync(envFile)
    ? parseEnv(await Bun.file(envFile).text())
    : {};
  let prefix: string;
  try {
    prefix = resolvePrefix(flagValue(args, "--prefix"), values["STACK_PREFIX"]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const namePrefix = prefix ? `${prefix}-` : "";
  const compose = `docker compose -f ${DEPLOY_DIR}/docker-compose.yaml --env-file ${envFile}`;
  console.log(
    `dry run: nothing is pulled, built, started or written (env file ${envFile}, stack ${prefix || "default"})`,
  );
  console.log(
    renderPlan(
      deploySteps({
        options,
        apiRoot: API_ROOT,
        uiRoot: uiContext(values),
        compose,
        namePrefix,
      }),
    ),
  );
  if (!options.backup) console.log(`\n${BACKUP_OFF_LINE}`);
  const problems = existsSync(envFile)
    ? envProblems(values, { backup: options.backup })
    : [`${envFile} is missing: cp deploy/.env.example ${envFile}, fill it`];
  if (problems.length > 0) {
    console.log(`\nthe real run would stop on:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nthe env file is complete; the real run would go ahead");
  process.exit(0);
}

const stack = await loadStack(args);

const problems = envProblems(stack.values, { backup: options.backup });
if (problems.length > 0)
  fail(`the settings in ${stack.envFile}:\n  ${problems.join("\n  ")}`);

const proxy = await $`docker network inspect proxy`.quiet().nothrow();
if (proxy.exitCode !== 0)
  fail(
    "the external docker network `proxy` does not exist (nxgt-docker creates it)",
  );

if (!options.noPull) {
  const dirs = options.ui ? [API_ROOT, uiContext(stack.values)] : [API_ROOT];
  for (const dir of dirs) {
    const out = (await $`git pull --ff-only`.cwd(dir).text())
      .trim()
      .split("\n")
      .pop();
    step("pull", `${dir}: ${out}`);
  }
} else {
  step("skip", "git pull (--no-pull)");
}

if (githubToken(process.env) === undefined)
  fail(
    `no GitHub Packages token: the image build installs the private @softistx/* packages. Export GITHUB_TOKEN, or log gh in with read:packages (gh auth refresh -s read:packages), or put a classic token with read:packages in ${GITHUB_TOKEN_FILE} (mode 600)`,
  );
const profile = [
  ...(options.ui ? ["--profile", "ui"] : []),
  ...(options.backup ? ["--profile", "backup"] : []),
];
if (!options.backup) step("backup", BACKUP_OFF_LINE);
step(
  "build",
  `api, ${options.backup ? "backup, " : ""}minio-init (cached layers make a rerun cheap)`,
);
await stack.compose(...profile, "build");

step("up", "");
await stack.compose(
  ...profile,
  "up",
  "-d",
  "--remove-orphans",
  "--wait",
  "--wait-timeout",
  timeout,
);

await stack.compose(
  ...profile,
  "ps",
  "--format",
  "table {{.Name}}\t{{.Status}}",
);
step("healthy", `${stack.namePrefix}pulsarix is up`);

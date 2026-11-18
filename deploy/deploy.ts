#!/usr/bin/env bun
/**
 * Deploys the pulsarix-api staging stack on this machine, by hand and
 * idempotently: git pull the checkout, build the images here (there is no
 * registry), `up --wait` until every service is healthy. A rerun with nothing
 * changed pulls nothing, rebuilds from cache and recreates no container; only
 * the health wait does work. Migrations are not a step: the API creates each
 * database's validators and indexes on first use (MONGO_AUTO_SYNC).
 *
 * The images install the private @softistx/* packages (npm.softistx.com): the
 * build needs the read token, from $NPM_REGISTRY_TOKEN or
 * ~/.config/pulsarix/npm-registry-token, handed to BuildKit as a secret.
 *
 *   bun deploy/deploy.ts [--env deploy/.env] [--prefix staging]
 *                        [--no-pull] [--ui] [--widget] [--backup]
 *                        [--timeout 300] [--dry-run]
 *
 *   --env      the stack's env file (default deploy/.env); it must exist and be
 *              mode 600, or the script refuses to run
 *   --prefix   STACK_PREFIX, overriding the file (a second stack)
 *   --no-pull  skip `git pull` (a checkout on a feature branch)
 *   --ui       also build and start pulsarix-ui (compose profile `ui`)
 *   --widget   deploy the widget bundle only (no stack step): pull and install
 *              pulsarix-widget, build it in a scratch copy, copy the result into
 *              the served `dist` in place (the UI container's bind mount keeps
 *              working: no restart, no 404 window), then check
 *              /widget/v1/loader.js answers through the container
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
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import {
  API_ROOT,
  DEPLOY_DIR,
  fail,
  flagValue,
  loadStack,
  parseEnv,
  REGISTRY_TOKEN_FILE,
  registryToken,
  resolvePrefix,
  uiContext,
} from "./lib";
import {
  BACKUP_OFF_LINE,
  deploySteps,
  envProblems,
  renderPlan,
  staleImages,
} from "./plan";
import { manifestWidget, planWidgetSync, widgetPaths } from "./widget";

const args = Bun.argv.slice(2);
const known = new Set([
  "--env",
  "--prefix",
  "--no-pull",
  "--ui",
  "--widget",
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

if (args.includes("--widget")) {
  for (const f of ["--ui", "--backup", "--timeout"])
    if (args.includes(f))
      fail(
        `--widget takes only --env, --prefix, --no-pull and --dry-run, not ${f}`,
      );
  await deployWidget();
  process.exit(0);
}

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

if (registryToken(process.env) === undefined)
  fail(
    `no registry token: the image build installs the @softistx/* packages from npm.softistx.com. Export NPM_REGISTRY_TOKEN, or put the read token in ${REGISTRY_TOKEN_FILE} (mode 600)`,
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

// Free the disk once the new containers are healthy (never before: a failed deploy
// keeps the old images to roll back to). Only this app's images; never
// `system prune -a` nor `--volumes`. The widget path (--widget) builds no image and
// never gets here.
const lines = async (cmd: Promise<{ stdout: Buffer }>) =>
  (await cmd).stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
await $`docker image prune -f`.quiet().nothrow();
const stale = staleImages({
  images: await lines(
    $`docker image ls --format ${"{{.Repository}}:{{.Tag}}"}`.quiet().nothrow(),
  ),
  inUse: await lines(
    $`docker ps -a --format ${"{{.Image}}"}`.quiet().nothrow(),
  ),
  keepTag: process.env["TAG"] ?? stack.values["TAG"] ?? "local",
  namePrefix: stack.namePrefix,
});
for (const ref of stale) await $`docker rmi ${ref}`.quiet().nothrow();
await $`docker builder prune -f --filter until=24h`.quiet().nothrow();
step(
  "prune",
  `${stale.length} old pulsarix image tag(s) removed, build cache > 24 h`,
);

/** Every file under `dir`, relative, with `/` separators; none when it is absent. */
async function listFiles(dir: string, base = ""): Promise<string[]> {
  const entries = await readdir(join(dir, base), { withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await listFiles(dir, rel)));
    else files.push(rel);
  }
  return files;
}

/**
 * `--widget`: see the header and widget.ts. The build runs in a scratch copy
 * of the checkout (tracked files, node_modules linked), so `dist` is never
 * deleted; its files are copied in, the loader and manifest last, each through
 * a temporary name and a rename so no request reads half a file.
 */
async function deployWidget(): Promise<void> {
  const envFile = flagValue(args, "--env") ?? `${DEPLOY_DIR}/.env`;
  const values = existsSync(envFile)
    ? parseEnv(await Bun.file(envFile).text())
    : {};
  let prefix: string;
  try {
    prefix = resolvePrefix(flagValue(args, "--prefix"), values["STACK_PREFIX"]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const container = `${prefix ? `${prefix}-` : ""}pulsarix-ui`;
  const { dist, root } = widgetPaths(values, DEPLOY_DIR);
  const probe = ["docker", "exec", container, "wget", "-qO-"];
  const url = "http://127.0.0.1:3000/widget/v1/loader.js";
  const pull = options.noPull
    ? "skip git pull (--no-pull)"
    : `git -C ${root} pull --ff-only`;

  if (args.includes("--dry-run")) {
    console.log(
      `dry run: nothing is pulled, built or written (widget ${root}, served dist ${dist})`,
    );
    console.log(
      renderPlan([
        { name: "pull", detail: root, command: pull },
        {
          name: "install",
          detail: root,
          command: `bun install --frozen-lockfile`,
        },
        {
          name: "build",
          detail: "in a scratch copy of the checkout, so dist is never deleted",
          command: "bun scripts/build.ts",
        },
        {
          name: "copy",
          detail: `into ${dist} in place, loader.js and manifest.json last; the mount keeps working, no restart`,
        },
        {
          name: "clean",
          detail:
            "stale files after the new loader is in place, keeping the bundle the previous manifest named",
        },
        {
          name: "check",
          detail: "/widget/v1/loader.js answers 200",
          command: `${probe.join(" ")} ${url}`,
        },
      ]),
    );
    return;
  }

  if (!existsSync(root)) fail(`no widget checkout at ${root}`);
  if (options.noPull) step("skip", "git pull (--no-pull)");
  else {
    const out = (await $`git pull --ff-only`.cwd(root).text())
      .trim()
      .split("\n")
      .pop();
    step("pull", `${root}: ${out}`);
  }
  await $`bun install --frozen-lockfile`.cwd(root);

  const scratch = await mkdtemp(join(tmpdir(), "widget-build-"));
  try {
    const tracked = (await $`git ls-files -z`.cwd(root).text())
      .split("\0")
      .filter((f) => f !== "" && existsSync(join(root, f)));
    for (const f of tracked) {
      await mkdir(dirname(join(scratch, f)), { recursive: true });
      await cp(join(root, f), join(scratch, f));
    }
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"));
    step("build", `${scratch} (scratch copy of ${root})`);
    await $`bun scripts/build.ts`.cwd(scratch);

    const built = await listFiles(join(scratch, "dist"));
    if (!built.includes("loader.js") || !built.includes("manifest.json"))
      fail(
        "the build produced no loader.js or manifest.json: dist left as it was",
      );
    const existing = await listFiles(dist);
    const keep = manifestWidget(
      await readFile(join(dist, "manifest.json"), "utf8").catch(
        () => undefined,
      ),
    );
    const { copy, stale } = planWidgetSync({ built, existing, keep });
    for (const f of copy) {
      const target = join(dist, f);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await Bun.write(tmp, Bun.file(join(scratch, "dist", f)));
      await rename(tmp, target);
    }
    step("copy", `${copy.length} files into ${dist}`);
    for (const f of stale) await rm(join(dist, f), { force: true });
    step(
      "clean",
      `${stale.length} stale file(s)${keep ? `, kept ${keep}` : ""}`,
    );

    const res = await $`${probe} ${url}`.quiet().nothrow();
    if (res.exitCode !== 0 || res.stdout.length === 0)
      fail(
        `/widget/v1/loader.js did not answer 200 through ${container}: is the UI up (--ui)? Is the mount stale (docker restart ${container})?`,
      );
    const built_loader = Buffer.from(
      await Bun.file(join(scratch, "dist", "loader.js")).arrayBuffer(),
    );
    if (!res.stdout.equals(built_loader))
      fail(
        `/widget/v1/loader.js through ${container} is not the loader just built: the mount is stale (docker restart ${container})`,
      );
    step(
      "healthy",
      `/widget/v1/loader.js answers through ${container} and is the new build (${res.stdout.length} bytes)`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

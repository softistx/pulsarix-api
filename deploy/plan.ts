/**
 * What deploy.ts does, as data: the env-file checks and the ordered steps, so
 * `--dry-run` can print them without touching a server and the specs can pin
 * them. Pure: nothing here runs a command, reads a file or opens a socket.
 */

import { backupProblems } from "./backup";

/** The secrets and addresses the stack cannot start without (compose `${X:?}`). */
export const REQUIRED = [
  "UI_HOSTNAME",
  "MONGO_ROOT_PASSWORD",
  "MONGO_KEYFILE",
  "MONGO_APP_PASSWORD",
  "REDIS_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "TOTP_KEYS",
  "MAIL_FROM",
  "MAIL_URL",
] as const;

/** Passwords that sit in a URL: no character that needs escaping there. */
const URL_SAFE = ["MONGO_APP_PASSWORD", "REDIS_PASSWORD"] as const;

/**
 * What is wrong with the env file, one message each: a required name that is
 * missing, empty or still CHANGE_ME, a URL password with a character that
 * needs escaping, a UI_ORIGIN that is not https (the API refuses it in
 * production), and, with `backup`, the backup settings (backup.ts). Without
 * it nothing about the backup is required.
 */
export function envProblems(
  values: Record<string, string>,
  { backup = false }: { backup?: boolean } = {},
): string[] {
  const problems: string[] = [];
  for (const name of REQUIRED) {
    const value = values[name];
    if (value === undefined || value === "" || value === "CHANGE_ME")
      problems.push(`${name} is required`);
  }
  for (const name of URL_SAFE) {
    const value = values[name];
    if (value && value !== "CHANGE_ME" && !/^[A-Za-z0-9._~-]+$/.test(value))
      problems.push(
        `${name} must use letters, digits, . _ ~ - only (it sits in a URL): openssl rand -hex 24`,
      );
  }
  const scheme = values["PUBLIC_SCHEME"];
  if (scheme !== undefined && scheme !== "" && scheme !== "https")
    problems.push(
      "PUBLIC_SCHEME must be https: the API runs with NODE_ENV=production and refuses an http UI_ORIGIN",
    );
  const hostname = values["UI_HOSTNAME"];
  if (hostname && hostname !== "CHANGE_ME" && !/^[a-z0-9.-]+$/i.test(hostname))
    problems.push("UI_HOSTNAME must be a bare hostname (no scheme, no path)");
  return backup ? [...problems, ...backupProblems(values)] : problems;
}

export type DeployOptions = {
  /** `--no-pull`: leave the checkouts as they are. */
  noPull: boolean;
  /** `--backup`: also build and start the offsite backup (profile `backup`). */
  backup: boolean;
  /** `--ui`: also build and start the UI (profile `ui`). */
  ui: boolean;
  /** `--timeout`: seconds `up --wait` waits for healthy containers. */
  timeout: string;
};

export type Step = {
  name: string;
  detail: string;
  /** The command, for the plan; absent for a check done in-process. */
  command?: string;
};

/**
 * The ordered steps of a deploy. `apiRoot` and `uiRoot` are the checkouts,
 * `compose` the `docker compose -f ... --env-file ...` prefix.
 */
export function deploySteps(input: {
  options: DeployOptions;
  apiRoot: string;
  uiRoot: string;
  compose: string;
  namePrefix: string;
}): Step[] {
  const { options, apiRoot, uiRoot, compose, namePrefix } = input;
  const profile =
    (options.ui ? " --profile ui" : "") +
    (options.backup ? " --profile backup" : "");
  const steps: Step[] = [
    {
      name: "check",
      detail: options.backup
        ? "the env file is mode 600 and complete; the backup settings hold"
        : "the env file is mode 600 and complete (backup off)",
    },
    {
      name: "network",
      detail: "the external docker network `proxy` exists",
      command: "docker network inspect proxy",
    },
  ];
  if (options.noPull) {
    steps.push({ name: "skip", detail: "git pull (--no-pull)" });
  } else {
    steps.push({
      name: "pull",
      detail: apiRoot,
      command: `git -C ${apiRoot} pull --ff-only`,
    });
    if (options.ui)
      steps.push({
        name: "pull",
        detail: uiRoot,
        command: `git -C ${uiRoot} pull --ff-only`,
      });
  }
  steps.push(
    {
      name: "token",
      detail:
        "the npm.softistx.com read token for the image build, from $NPM_REGISTRY_TOKEN or ~/.config/pulsarix/npm-registry-token",
    },
    {
      name: "build",
      detail: `${namePrefix}pulsarix-api (its Dockerfile renders a PDF preview, so a missing native binary fails here), ${options.backup ? "backup, " : ""}minio-init${options.ui ? ", ui" : ""}`,
      command: `${compose}${profile} build`,
    },
    {
      name: "up",
      detail: `mongo, redis, minio, init one-shots, ${options.backup ? "backup, " : ""}api${options.ui ? ", ui" : ""}; waits up to ${options.timeout}s for healthy`,
      command: `${compose}${profile} up -d --remove-orphans --wait --wait-timeout ${options.timeout}`,
    },
    {
      name: "status",
      detail: "every service listed with its health",
      command: `${compose}${profile} ps`,
    },
  );
  return steps;
}

/** The one line printed when `--backup` is not given. */
export const BACKUP_OFF_LINE =
  "backup off: no offsite copy (add --backup, with BACKUP_S3_* set, to enable it)";

/** One printed line per step: `  name      detail` and, indented, its command. */
export function renderPlan(steps: Step[]): string {
  return steps
    .map((s, i) => {
      const head = `  ${String(i + 1).padStart(2)}. ${s.name.padEnd(8)} ${s.detail}`;
      return s.command ? `${head}\n      $ ${s.command}` : head;
    })
    .join("\n");
}

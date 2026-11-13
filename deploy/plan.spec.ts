import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "./lib";
import { deploySteps, envProblems, REQUIRED, renderPlan } from "./plan";

const example = parseEnv(
  readFileSync(join(import.meta.dir, ".env.example"), "utf8"),
);
const filled = Object.fromEntries(
  Object.entries(example).map(([k, v]) => [
    k,
    v === "CHANGE_ME" ? "a1b2c3" : v,
  ]),
);
// Values the example leaves empty on purpose, or that need a URL shape.
filled["BACKUP_S3_ENDPOINT"] = "https://s3.example.test";

describe("envProblems", () => {
  test(".env.example names every required variable, all still CHANGE_ME", () => {
    for (const name of REQUIRED) expect(example).toHaveProperty(name);
    const problems = envProblems(example);
    for (const name of REQUIRED.filter((n) => example[n] === "CHANGE_ME")) {
      expect(problems.some((p) => p.startsWith(name))).toBe(true);
    }
  });

  test("a filled file has no problem", () => {
    expect(envProblems(filled)).toEqual([]);
  });

  test("reports a missing name once, the backup password included", () => {
    const { REDIS_PASSWORD: _a, MONGO_BACKUP_PASSWORD: _b, ...rest } = filled;
    const problems = envProblems(rest);
    expect(problems.filter((p) => p.startsWith("REDIS_PASSWORD"))).toHaveLength(
      1,
    );
    expect(
      problems.filter((p) => p.startsWith("MONGO_BACKUP_PASSWORD")),
    ).toHaveLength(1);
  });

  test("refuses a URL password that needs escaping and an http scheme", () => {
    const problems = envProblems({
      ...filled,
      REDIS_PASSWORD: "p@ss/word",
      PUBLIC_SCHEME: "http",
      UI_HOSTNAME: "https://pulsarix.softistx.com/",
    });
    expect(problems.join("\n")).toContain("REDIS_PASSWORD must use");
    expect(problems.join("\n")).toContain("PUBLIC_SCHEME must be https");
    expect(problems.join("\n")).toContain("UI_HOSTNAME must be a bare");
  });
});

describe("deploySteps", () => {
  const input = {
    options: { noPull: false, ui: false, timeout: "300" },
    apiRoot: "/srv/pulsarix-api",
    uiRoot: "/srv/pulsarix-ui",
    compose: "docker compose -f c.yaml --env-file e",
    namePrefix: "",
  };
  const names = (steps: ReturnType<typeof deploySteps>) =>
    steps.map((s) => s.name);

  test("check, network, pull, token, build, up, status, in that order", () => {
    expect(names(deploySteps(input))).toEqual([
      "check",
      "network",
      "pull",
      "token",
      "build",
      "up",
      "status",
    ]);
  });

  test("--no-pull skips the pull, --ui adds the UI checkout and profile", () => {
    expect(
      names(
        deploySteps({ ...input, options: { ...input.options, noPull: true } }),
      ),
    ).toContain("skip");
    const ui = deploySteps({
      ...input,
      options: { ...input.options, ui: true },
    });
    expect(ui.filter((s) => s.name === "pull")).toHaveLength(2);
    expect(ui.find((s) => s.name === "up")?.command).toContain("--profile ui");
    expect(
      deploySteps(input).find((s) => s.name === "up")?.command,
    ).not.toContain("--profile");
  });

  test("waits for healthy containers for the given timeout", () => {
    const up = deploySteps({
      ...input,
      options: { ...input.options, timeout: "90" },
    }).find((s) => s.name === "up");
    expect(up?.command).toContain("--wait --wait-timeout 90");
  });

  test("renders one numbered line per step, a command under its step", () => {
    const text = renderPlan(deploySteps(input));
    expect(text.split("\n").filter((l) => /^\s+\d+\./.test(l))).toHaveLength(7);
    expect(text).toContain("$ git -C /srv/pulsarix-api pull --ff-only");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The compose file and the Dockerfile are read as text and as YAML: what the
// slice promises (routing, proxies, Redis, no published port) is pinned here
// without Docker. `docker compose config` checks the same file in the PR's run.
const dir = import.meta.dir;
// Compose interpolation, written without a template-looking string.
const v = (expr: string) => ["$", "{", expr, "}"].join("");
const composeText = readFileSync(join(dir, "docker-compose.yaml"), "utf8");
const compose = Bun.YAML.parse(composeText) as {
  services: Record<
    string,
    {
      ports?: unknown;
      profiles?: string[];
      depends_on?: Record<string, { condition: string }>;
      environment?: Record<string, string>;
      labels?: string[];
    }
  >;
  networks: Record<string, { external?: boolean }>;
};
const apiEnv = (compose.services["api"]?.environment ?? {}) as Record<
  string,
  string
>;

describe("docker-compose.yaml", () => {
  test("every service sits on the external proxy network and publishes no port", () => {
    expect(compose.networks["proxy"]?.external).toBe(true);
    for (const [name, service] of Object.entries(compose.services))
      expect(service.ports, `${name} publishes a port`).toBeUndefined();
  });

  test("the stack is mongo, redis, minio, their init one-shots, backup, api and an optional ui", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "api",
      "backup",
      "minio",
      "minio-init",
      "mongo",
      "mongo-init",
      "redis",
      "ui",
    ]);
    expect(compose.services["ui"]?.profiles).toEqual(["ui"]);
  });

  test("the API waits for a healthy Redis (the intake endpoint answers 503 without it) and gets REDIS_URL", () => {
    expect(compose.services["api"]?.depends_on?.["redis"]?.condition).toBe(
      "service_healthy",
    );
    expect(apiEnv["REDIS_URL"]).toMatch(/^redis:\/\/:\$\{REDIS_PASSWORD:\?\}@/);
  });

  test("the API trusts the docker range as proxies, never a hop count or a vendor keyword", () => {
    expect(apiEnv["TRUSTED_PROXIES"]).toBe(v("TRUSTED_PROXIES:-172.16.0.0/12"));
    expect(composeText).not.toMatch(/CF-Connecting-IP|X-Real-Ip/i);
  });

  test("production settings: https origin, required TOTP keys, auto sync for the per-organisation databases", () => {
    expect(apiEnv["NODE_ENV"]).toBe("production");
    expect(apiEnv["UI_ORIGIN"]).toContain(v("UI_HOSTNAME:?"));
    expect(apiEnv["TOTP_KEYS"]).toBe(v("TOTP_KEYS:?"));
    expect(apiEnv["MONGO_AUTO_SYNC"]).toBe("true");
  });

  test("only the intake endpoint is routed to the API, on the one hostname, above the UI", () => {
    const labels = compose.services["api"]?.labels ?? [];
    expect(labels).toContain("traefik.enable=true");
    const rule = labels.find((l) => l.includes(".rule="));
    expect(rule).toContain(
      `Host(\`${v("UI_HOSTNAME:?")}\`) && PathPrefix(\`/public/\`)`,
    );
    expect(labels.some((l) => l.endsWith(".priority=100"))).toBe(true);
    expect(
      labels.some((l) => l.includes("loadbalancer.server.port=3000")),
    ).toBe(true);
    // The data services are never routed.
    for (const name of ["mongo", "redis", "minio", "backup"])
      expect(compose.services[name]?.labels).toContain("traefik.enable=false");
  });

  test("no DNS record is part of the stack", () => {
    expect(composeText).not.toMatch(/cloudflare.*(record|zone)|dns_record/i);
  });
});

describe("Dockerfile", () => {
  const dockerfile = readFileSync(join(dir, "..", "Dockerfile"), "utf8");

  test("Bun is pinned to the version CI uses, on glibc for the native canvas binary", () => {
    const ci = readFileSync(
      join(dir, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const bun = /bun-version:\s*(\S+)/.exec(ci)?.[1];
    expect(bun).toBeDefined();
    expect(dockerfile).toContain(`FROM oven/bun:${bun} AS build`);
    expect(dockerfile).toContain(`FROM oven/bun:${bun}-slim`);
    expect(dockerfile).not.toContain("alpine");
  });

  test("the image ships @napi-rs/canvas and proves a PDF preview renders before it is done", () => {
    expect(dockerfile).toContain("@napi-rs/canvas");
    const copy = dockerfile.indexOf("COPY --from=build /native/node_modules");
    const check = dockerfile.indexOf(
      "RUN bun --no-install dist/scripts/pdf-preview-check.js",
    );
    const user = dockerfile.indexOf("USER bun");
    expect(copy).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(copy);
    expect(user).toBeGreaterThan(check);
  });

  test("the build scripts bundle the server and the check with the canvas left external", () => {
    const pkg = JSON.parse(
      readFileSync(join(dir, "..", "package.json"), "utf8"),
    );
    expect(pkg.scripts.build).toContain("--external @napi-rs/canvas");
    expect(pkg.scripts.build).toContain("--external pdfjs-dist");
    expect(pkg.scripts["build:scripts"]).toContain("pdf-preview-check.ts");
    expect(pkg.scripts["build:scripts"]).toContain(
      "--external @napi-rs/canvas",
    );
  });
});

describe("ci.yml", () => {
  const ci = readFileSync(
    join(dir, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );

  test("stays one job and gives the Redis-backed specs a server through REDIS_BIN", () => {
    const jobs = ci.slice(ci.indexOf("\njobs:"));
    expect(jobs.match(/^ {2}[a-z][\w-]*:\s*$/gm)).toEqual(["  verify:"]);
    expect(ci).toContain(`REDIS_BIN: ${v("{ steps.redis-bin.outputs.bin }")}`);
    expect(ci).toContain("redis-server");
    expect(ci).not.toContain("services:");
  });
});

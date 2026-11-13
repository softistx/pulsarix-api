import { describe, expect, test } from "bun:test";

// env.ts parses at import, so each case reads it in a process of its own.
const run = async (nodeEnv: string, url?: string) => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      'console.log(String((await import("./env")).env.CHRONIX_URL))',
    ],
    {
      cwd: import.meta.dir,
      env: {
        PATH: Bun.env["PATH"] ?? "",
        NODE_ENV: nodeEnv,
        MONGO_URI: "mongodb://localhost:27017",
        UI_ORIGIN: "https://pulsarix.test",
        MAIL_FROM: "noreply@pulsarix.test",
        MAIL_URL: "smtp://localhost:1025",
        TOTP_KEYS: "k:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        REDIS_URL: "redis://localhost:6379",
        API_PROXY_SECRET: "s".repeat(32),
        ...(url === undefined ? {} : { CHRONIX_URL: url }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const err = await new Response(proc.stderr).text();
  return { out, err, code: await proc.exited };
};

describe("CHRONIX_URL", () => {
  test("production refuses http", async () => {
    const result = await run("production", "http://chronix.test");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("CHRONIX_URL");
  });

  test("production accepts https, and defaults to chronix's host", async () => {
    expect((await run("production", "https://chronix.test")).out).toBe(
      "https://chronix.test",
    );
    expect((await run("production")).out).toBe("https://chronix.softistx.com");
  });

  test("development accepts http", async () => {
    expect((await run("development", "http://localhost:4000")).out).toBe(
      "http://localhost:4000",
    );
  });
});

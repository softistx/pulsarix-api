import { describe, expect, test } from "bun:test";

// env.ts parses at import, so each case reads it in a process of its own.
// `secret` undefined leaves API_PROXY_SECRET out of the environment.
const run = async (nodeEnv: string, secret?: string) => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      'console.log(String((await import("./env")).env.API_PROXY_SECRET))',
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
        ...(secret === undefined ? {} : { API_PROXY_SECRET: secret }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
};

const refused = (result: { out: string; err: string; code: number }) => {
  expect(result.code).not.toBe(0);
  expect(result.out).toBe("");
  expect(result.err).toContain("API_PROXY_SECRET");
};

describe("API_PROXY_SECRET in production", () => {
  test("a missing value stops the process", async () => {
    refused(await run("production"));
  });

  test("an empty value stops the process", async () => {
    refused(await run("production", ""));
  });

  test("a 31-character value stops the process", async () => {
    refused(await run("production", "s".repeat(31)));
  });

  test("a 32-character value is accepted", async () => {
    const secret = "s".repeat(32);
    const result = await run("production", secret);
    expect(result.code).toBe(0);
    expect(result.out).toBe(secret);
  });
});

describe("API_PROXY_SECRET outside production", () => {
  test("a missing or empty value is unset", async () => {
    for (const secret of [undefined, ""]) {
      const result = await run("development", secret);
      expect(result.code).toBe(0);
      expect(result.out).toBe("undefined");
    }
  });

  test("a 31-character value is still refused", async () => {
    refused(await run("development", "s".repeat(31)));
  });

  test("a 32-character value is accepted", async () => {
    const secret = "s".repeat(32);
    const result = await run("development", secret);
    expect(result.code).toBe(0);
    expect(result.out).toBe(secret);
  });
});

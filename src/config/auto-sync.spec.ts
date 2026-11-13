import { describe, expect, test } from "bun:test";
import { autoSyncOf } from "./auto-sync";

describe("autoSyncOf", () => {
  test("is always on outside production", () => {
    expect(autoSyncOf(false, false)).toBe(true);
    expect(autoSyncOf(false, true)).toBe(true);
  });

  test("in production it follows MONGO_AUTO_SYNC", () => {
    expect(autoSyncOf(true, false)).toBe(false);
    expect(autoSyncOf(true, true)).toBe(true);
  });
});

// env.ts parses at import, so each case reads it in a process of its own.
const parsed = async (nodeEnv: string, flag?: string) => {
  const proc = Bun.spawn(
    ["bun", "-e", 'console.log((await import("./env")).env.MONGO_AUTO_SYNC)'],
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
        ...(flag === undefined ? {} : { MONGO_AUTO_SYNC: flag }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
};

describe("MONGO_AUTO_SYNC in production", () => {
  test("is off when unset or empty", async () => {
    expect(await parsed("production")).toBe("false");
    expect(await parsed("production", "")).toBe("false");
  });

  test("is on for true, 1, yes and on, in any case", async () => {
    for (const on of ["true", "TRUE", "1", "yes", "on"])
      expect(await parsed("production", on)).toBe("true");
  });

  test("stays off for false", async () => {
    expect(await parsed("production", "false")).toBe("false");
  });
});

import { describe, expect, test } from "bun:test";

// env.ts parses at import, so each case reads it in a process of its own.
const load = async (proxies: string) => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      'console.log(JSON.stringify((await import("./env")).env.TRUSTED_PROXIES ?? null))',
    ],
    {
      cwd: import.meta.dir,
      env: {
        PATH: Bun.env["PATH"] ?? "",
        NODE_ENV: "test",
        MONGO_URI: "mongodb://localhost:27017",
        UI_ORIGIN: "https://pulsarix.test",
        MAIL_FROM: "noreply@pulsarix.test",
        MAIL_URL: "smtp://localhost:1025",
        TOTP_KEYS: "k:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        TRUSTED_PROXIES: proxies,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const err = await new Response(proc.stderr).text();
  return { out, err, code: await proc.exited };
};

describe("TRUSTED_PROXIES", () => {
  test.each([
    "0.0.0.0/0",
    "::/0",
    "10.0.0.1:8080",
    "172.16.0.0/12,,10.0.0.0/8",
    "not-a-proxy",
  ])("refuses %p", async (value) => {
    const r = await load(value);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("TRUSTED_PROXIES");
  });

  test("accepts a list of addresses and ranges", async () => {
    const r = await load("172.16.0.0/12, 10.0.0.1");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(["172.16.0.0/12", "10.0.0.1"]);
  });

  test("accepts cloudflare", async () => {
    const r = await load("cloudflare");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).length).toBeGreaterThan(1);
  });

  test("an empty value is unset", async () => {
    const r = await load("");
    expect(r.code).toBe(0);
    expect(r.out).toBe("null");
  });
});

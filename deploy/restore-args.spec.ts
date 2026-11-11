import { describe, expect, test } from "bun:test";
import { type RestoreOptions, restoreOptions } from "./restore-args";

const ctx = { stackPrefix: "", values: {} as Record<string, string> };
const ok = (args: string[], c = ctx) => {
  const r = restoreOptions(args, c);
  if (r instanceof Error) throw r;
  return r as RestoreOptions;
};
const err = (args: string[], c = ctx) => {
  const r = restoreOptions(args, c);
  if (!(r instanceof Error)) throw new Error("expected an error");
  return r.message;
};

describe("restoreOptions", () => {
  test("--yes is required", () => {
    expect(err(["--confirm", "default"])).toContain("--yes");
  });
  test("--confirm must name the stack: default when unprefixed, else the prefix", () => {
    expect(err(["--yes"])).toContain("got nothing");
    expect(err(["--yes", "--confirm", "demo"])).toContain("--confirm default");
    expect(ok(["--yes", "--confirm", "default"]).target).toBe("default");
    const demo = { stackPrefix: "demo", values: {} };
    expect(err(["--yes", "--confirm", "default"], demo)).toContain(
      "--confirm demo",
    );
    expect(ok(["--yes", "--confirm", "demo"], demo).target).toBe("demo");
  });
  test("unknown flags and flags without a value are refused", () => {
    expect(err(["--yes", "--confirm", "default", "--local"])).toContain(
      "unknown flag --local",
    );
    expect(err(["--yes", "--confirm"])).toContain("--confirm needs a value");
    expect(err(["--yes", "--confirm", "default", "--file"])).toContain(
      "--file needs a value",
    );
  });
  test("the dump name is latest or mongo-<timestamp>.tar", () => {
    const base = ["--yes", "--confirm", "default"];
    expect(ok(base).file).toBe("latest");
    expect(ok([...base, "--file", "mongo-20261109T030000Z.tar"]).file).toBe(
      "mongo-20261109T030000Z.tar",
    );
    for (const bad of [
      "../mongo-1.tar",
      "mongo-1.archive.gz",
      "x",
      "mongo-1.tar; rm",
    ])
      expect(err([...base, "--file", bad])).toContain("unexpected dump name");
  });
  test("--from-prefix implies --offsite and refuses unsafe prefixes", () => {
    const base = ["--yes", "--confirm", "default"];
    const o = ok([...base, "--from-prefix", "pulsarix-demo"]);
    expect(o.fromOffsite).toBe(true);
    expect(o.fromPrefix).toBe("pulsarix-demo");
    expect(ok(base).fromOffsite).toBe(false);
    expect(ok([...base, "--offsite", "--media"])).toMatchObject({
      fromOffsite: true,
      media: true,
    });
    for (const bad of ["..", "a/../b", "a b", "/a"])
      expect(err([...base, "--from-prefix", bad])).toContain("--from-prefix");
  });
  test("empty database settings fall back to the defaults, never to an empty prefix", () => {
    const base = ["--yes", "--confirm", "default"];
    const o = ok(base, {
      stackPrefix: "",
      values: { MONGO_CORE_DATABASE: "", MONGO_ORGANISATION_PREFIX: "" },
    });
    expect(o.core).toBe("pulsarix_core");
    expect(o.orgPrefix).toBe("pulsarix_org_");
    expect(
      ok(base, { stackPrefix: "", values: { MONGO_ORGANISATION_PREFIX: "x_" } })
        .orgPrefix,
    ).toBe("x_");
    expect(
      err(base, {
        stackPrefix: "",
        values: { MONGO_ORGANISATION_PREFIX: "a b" },
      }),
    ).toContain("MONGO_ORGANISATION_PREFIX");
  });
  test("--database restricts the restore to the core database or one organisation's", () => {
    const base = ["--yes", "--confirm", "default"];
    expect(ok(base).database).toBe("");
    expect(ok([...base, "--database", "pulsarix_core"]).database).toBe(
      "pulsarix_core",
    );
    expect(ok([...base, "--database", "pulsarix_org_abc"]).database).toBe(
      "pulsarix_org_abc",
    );
    for (const bad of [
      "admin",
      "other",
      "pulsarix_org",
      "pulsarix_org_a b",
      "pulsarix_org_a;x",
    ])
      expect(err([...base, "--database", bad])).toContain("--database");
    expect(err([...base, "--database"])).toContain("--database needs a value");
  });
});

import { describe, expect, test } from "bun:test";
import {
  assertScratch,
  compareDatabases,
  parseDrillOutput,
  scratchCore,
  scratchPrefix,
  summarize,
} from "./drill";

const prefix = scratchPrefix(new Date("2026-11-09T03:04:05.678Z"));

describe("scratchPrefix", () => {
  test("is drill_<compact UTC timestamp>_", () => {
    expect(prefix).toBe("drill_20261109T030405Z_");
    expect(scratchCore(prefix)).toBe("drill_20261109T030405Z_core");
  });
});

describe("assertScratch", () => {
  test("accepts a prefix apart from the live databases", () => {
    expect(() =>
      assertScratch(prefix, "pulsarix_core", "pulsarix_org_"),
    ).not.toThrow();
  });

  test("refuses a malformed prefix", () => {
    for (const bad of [
      "",
      "pulsarix_",
      "drill_",
      "drill_x y_",
      "pulsarix_org_",
    ])
      expect(() =>
        assertScratch(bad, "pulsarix_core", "pulsarix_org_"),
      ).toThrow("unexpected scratch prefix");
  });

  test("refuses a core database that the scratch names could hit", () => {
    expect(() =>
      assertScratch(prefix, `${prefix}core`, "pulsarix_org_"),
    ).toThrow("live core database");
  });

  test("refuses an organisation prefix that overlaps the scratch one", () => {
    expect(() => assertScratch(prefix, "pulsarix_core", "drill_")).toThrow(
      "overlaps",
    );
    expect(() => assertScratch(prefix, "pulsarix_core", "")).toThrow(
      "overlaps",
    );
  });
});

const core = ["organisations", "users"];
const org = ["units", "taxes"];

describe("compareDatabases", () => {
  test("passes when every expected collection is in the core and each organisation", () => {
    const r = compareDatabases(core, org, {
      core: { organisations: 1, users: 2 },
      organisations: { a: { units: 3, taxes: 0 }, b: { units: 0, taxes: 1 } },
    });
    expect(r.ok).toBe(true);
    expect(r.extra).toEqual([]);
  });

  test("fails on a missing core collection", () => {
    const r = compareDatabases(core, org, {
      core: { organisations: 1 },
      organisations: {},
    });
    expect(r.ok).toBe(false);
    expect(r.missingCore).toEqual(["users"]);
  });

  test("fails on a missing collection of any one organisation", () => {
    const r = compareDatabases(core, org, {
      core: { organisations: 1, users: 2 },
      organisations: { a: { units: 3, taxes: 0 }, b: { units: 0 } },
    });
    expect(r.ok).toBe(false);
    expect(r.missingOrganisations).toEqual({ b: ["taxes"] });
  });

  test("fails on a dump with no core database", () => {
    const r = compareDatabases(core, org, { core: {}, organisations: {} });
    expect(r.ok).toBe(false);
    expect(summarize("mongo-x.archive.gz", r)).toContain("NO core database");
  });

  test("an extra or system collection never fails; system ones are not reported", () => {
    const r = compareDatabases(core, org, {
      core: { organisations: 1, users: 2, legacy: 4, "system.views": 0 },
      organisations: {},
    });
    expect(r.ok).toBe(true);
    expect(r.extra).toEqual(["legacy"]);
  });
});

describe("summarize", () => {
  test("lists the counts per database and the verdict", () => {
    const text = summarize(
      "mongo-1.archive.gz",
      compareDatabases(core, org, {
        core: { organisations: 1, users: 2 },
        organisations: { a: { units: 3, taxes: 0 } },
      }),
    );
    expect(text).toContain("mongo-1.archive.gz restored");
    expect(text).toContain("organisation a");
    expect(text).toMatch(/units\s+3/);
    expect(text).toContain(
      "PASS: the core database and 1 organisation database",
    );
  });

  test("names what is missing and where", () => {
    const text = summarize(
      "d",
      compareDatabases(core, org, {
        core: { organisations: 1, users: 2 },
        organisations: { b: { units: 0 } },
      }),
    );
    expect(text).toContain("MISSING in organisation b: taxes");
    expect(text).toContain("FAIL: 1 problem(s)");
  });
});

describe("parseDrillOutput", () => {
  test("reads the dump name and the counts", () => {
    const out = `noise\nDRILL_DUMP mongo-1.archive.gz\nDRILL_COUNTS ${JSON.stringify({ core: { a: 1 }, organisations: { x: { b: 2 } } })}\n`;
    expect(parseDrillOutput(out)).toEqual({
      dump: "mongo-1.archive.gz",
      restored: { core: { a: 1 }, organisations: { x: { b: 2 } } },
    });
  });

  test("throws without counts", () => {
    expect(() => parseDrillOutput("DRILL_DUMP x\n")).toThrow(
      "no collection counts",
    );
  });
});

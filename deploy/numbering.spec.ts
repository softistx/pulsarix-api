import { describe, expect, test } from "bun:test";
import { issueCounters, issues } from "../src/modules/issues/issues.model";
import {
  checkNumbering,
  NUMBERING_EXPORT,
  parseNumberingOutput,
  summarizeNumbering,
} from "./numbering";

describe("the collections the export reads", () => {
  test("are the code's issues and issueCounters, with the fields it reads", () => {
    expect(issues.name).toBe("issues");
    expect(issueCounters.name).toBe("issueCounters");
    expect(NUMBERING_EXPORT).toContain(`getCollection("${issues.name}")`);
    expect(NUMBERING_EXPORT).toContain(
      `getCollection("${issueCounters.name}")`,
    );
    expect(Object.keys(issueCounters.schema.shape)).toEqual(
      expect.arrayContaining(["projectId", "last"]),
    );
    expect(Object.keys(issues.schema.shape)).toEqual(
      expect.arrayContaining(["projectId", "number"]),
    );
  });
});

describe("checkNumbering", () => {
  test("passes when every counter is at or ahead of its issues", () => {
    const result = checkNumbering({
      a: {
        counters: [
          { _id: "p1", last: 5 },
          { _id: "p2", last: 9 },
        ],
        issueMax: [
          { _id: "p1", max: 5 },
          { _id: "p2", max: 7 },
        ],
      },
    });
    expect(result).toMatchObject({ checked: 2, ahead: 1, ok: true });
    expect(summarizeNumbering(result)).toContain("numbering: PASS");
  });

  test("fails on a counter behind its issues or missing", () => {
    const result = checkNumbering({
      a: {
        counters: [{ _id: "p1", last: 3 }],
        issueMax: [
          { _id: "p1", max: 5 },
          { _id: "p2", max: 1 },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      { organisation: "a", projectId: "p1", counter: 3, highest: 5 },
      { organisation: "a", projectId: "p2", counter: 0, highest: 1 },
    ]);
    const text = summarizeNumbering(result);
    expect(text).toContain("NUMBERING BEHIND in organisation a: project p1");
    expect(text).toContain("numbering: FAIL, 2 counter(s)");
  });

  test("a project with no issues needs no counter", () => {
    expect(checkNumbering({ a: { counters: [], issueMax: [] } })).toMatchObject(
      { checked: 0, ok: true },
    );
  });
});

describe("parseNumberingOutput", () => {
  test("reads the NUMBERING_DATA line among others", () => {
    const data = { a: { counters: [], issueMax: [] } };
    expect(
      parseNumberingOutput(
        `DRILL_DUMP x\nNUMBERING_DATA ${JSON.stringify(data)}\n`,
      ),
    ).toEqual(data);
  });

  test("throws when the export printed nothing", () => {
    expect(() => parseNumberingOutput("DRILL_DUMP x")).toThrow();
  });
});

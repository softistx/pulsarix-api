import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { asText, changesBetween, changesFromNothing } from "./changes";

describe("field changes", () => {
  test("values are text: ids and dates in their text form, lists as JSON", () => {
    const id = new ObjectId();
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(asText(null)).toBeNull();
    expect(asText(id)).toBe(id.toHexString());
    expect(asText(date)).toBe("2026-01-02T03:04:05.000Z");
    expect(asText([id])).toBe(JSON.stringify([id.toHexString()]));
    expect(asText("x".repeat(600))?.length).toBe(501);
  });

  test("only the fields that differ are reported", () => {
    const a = new ObjectId();
    const before = { title: "A", labelIds: [a], dueDate: null as Date | null };
    const after = { title: "B", labelIds: [a], dueDate: new Date(0) };
    expect(
      changesBetween(before, after, ["title", "labelIds", "dueDate"]),
    ).toEqual([
      { field: "title", from: "A", to: "B" },
      { field: "dueDate", from: null, to: "1970-01-01T00:00:00.000Z" },
    ]);
  });

  test("a long text that differs past the clip is still a change", () => {
    const base = "x".repeat(600);
    expect(
      changesBetween({ d: `${base}a` }, { d: `${base}b` }, ["d"]),
    ).toHaveLength(1);
  });

  test("a new record reports what it sets, not what is empty", () => {
    expect(
      changesFromNothing({ title: "T", labelIds: [], assigneeId: null }, [
        "title",
        "labelIds",
        "assigneeId",
      ]),
    ).toEqual([{ field: "title", from: null, to: "T" }]);
  });
});

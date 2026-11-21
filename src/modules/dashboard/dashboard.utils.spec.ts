import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { ProjectDocument, StatusDocument } from "../projects/public";
import type { FigureRow } from "./dashboard.types";
import {
  after,
  baseOf,
  byName,
  type Cursor,
  decode,
  encode,
  lateOf,
  rowsById,
} from "./dashboard.utils";

const id = "0123456789abcdef01234567";
const cursor: Cursor = [1, 3, 1700000000000, id, "2026-01-02"];

describe("cursor", () => {
  test("round-trips on the same day", () => {
    expect(decode(encode(cursor), "2026-01-02")).toEqual(cursor);
  });
  test("a cursor of another day is refused", () => {
    expect(() => decode(encode(cursor), "2026-01-03")).toThrow();
  });
  test("garbage and malformed cursors are refused", () => {
    expect(() => decode("!!", "2026-01-02")).toThrow();
    expect(() =>
      decode(encode([2, 3, 1, id, "2026-01-02"] as Cursor), "2026-01-02"),
    ).toThrow();
    expect(() =>
      decode(encode([1, 3, 1, "nope", "2026-01-02"] as Cursor), "2026-01-02"),
    ).toThrow();
  });
});

describe("after", () => {
  test("lists the four tie-break levels of the sort order", () => {
    expect(after(cursor).$or).toHaveLength(4);
  });
});

describe("lateOf", () => {
  test("counts a due date before the start only", () => {
    const expr = lateOf(new Date("2026-01-02T00:00:00Z"));
    expect(expr.$cond[1]).toBe(1);
    expect(expr.$cond[2]).toBe(0);
  });
});

const status = (category: string) =>
  ({
    _id: new ObjectId(),
    id: new ObjectId().toHexString(),
    category,
  }) as unknown as StatusDocument;

describe("byName", () => {
  test("orders the projects by name without touching the input", () => {
    const input = [{ name: "b" }, { name: "A" }] as ProjectDocument[];
    expect(byName(input).map((p) => p.name)).toEqual(["A", "b"]);
    expect(input.map((p) => p.name)).toEqual(["b", "A"]);
  });
});

describe("baseOf", () => {
  test("open ids leave out done and cancelled, triage ids are among them", () => {
    const [triage, doing, done, cancelled] = [
      status("triage"),
      status("started"),
      status("done"),
      status("cancelled"),
    ] as [StatusDocument, StatusDocument, StatusDocument, StatusDocument];
    const base = baseOf([], [triage, doing, done, cancelled]);
    expect(base.openIds).toEqual([triage._id, doing._id]);
    expect(base.triageIds).toEqual([triage._id]);
    expect(base.statuses.size).toBe(4);
  });
});

describe("rowsById", () => {
  test("keys the rows by their project id", () => {
    const row = { _id: new ObjectId(), open: 1 } as FigureRow;
    expect(rowsById([row]).get(row._id.toHexString())).toBe(row);
  });
});

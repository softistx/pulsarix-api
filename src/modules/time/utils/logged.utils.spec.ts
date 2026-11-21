import { describe, expect, test } from "bun:test";
import type { LinkEntry } from "@softistx/chronix-react/server";
import { loggedOf } from "./logged.utils";

describe("loggedOf", () => {
  test("keeps the five fields a client reads and drops the rest", () => {
    const entry = {
      id: "e1",
      date: "2026-11-13",
      durationSeconds: 90,
      description: "Fix",
      billable: true,
      userEmail: "a@x.test",
    } as unknown as LinkEntry;
    expect(loggedOf(entry)).toEqual({
      id: "e1",
      date: "2026-11-13",
      durationSeconds: 90,
      description: "Fix",
      billable: true,
    });
  });
});

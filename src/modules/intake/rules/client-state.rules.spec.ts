import { describe, expect, test } from "bun:test";
import { combineMapped, isWaitingState } from "./client-state.rules";

describe("combineMapped", () => {
  test("nothing readable is null", () => {
    expect(combineMapped([])).toBeNull();
    expect(combineMapped([null])).toBeNull();
  });
  test("one issue maps to itself", () => {
    expect(combineMapped(["received"])).toBe("received");
    expect(combineMapped(["inProgress"])).toBe("inProgress");
    expect(combineMapped(["resolved"])).toBe("resolved");
    expect(combineMapped(["declined"])).toBe("declined");
  });
  test("any issue in progress is in progress", () => {
    expect(combineMapped(["inProgress", "resolved"])).toBe("inProgress");
    expect(combineMapped(["received", "inProgress"])).toBe("inProgress");
  });
  test("a resolved issue beside an unfinished one is not resolved yet", () => {
    expect(combineMapped(["resolved", "received"])).toBe("received");
  });
  test("resolved and declined together are resolved", () => {
    expect(combineMapped(["resolved", "declined"])).toBe("resolved");
    expect(combineMapped(["resolved", "resolved"])).toBe("resolved");
  });
  test("all declined is declined", () => {
    expect(combineMapped(["declined", "declined"])).toBe("declined");
  });
  test("an unreadable issue is ignored", () => {
    expect(combineMapped([null, "resolved"])).toBe("resolved");
  });
});

describe("isWaitingState", () => {
  test("resolved and declined do not wait", () => {
    expect(isWaitingState("received")).toBe(true);
    expect(isWaitingState("inProgress")).toBe(true);
    expect(isWaitingState("resolved")).toBe(false);
    expect(isWaitingState("declined")).toBe(false);
  });
});

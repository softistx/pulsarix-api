import { describe, expect, test } from "bun:test";
import type { LinkTimer } from "@softistx/chronix-react/server";
import { env } from "../../../config/env";
import { ISSUE, isOnIssue, refOf } from "./ref.utils";

const timer = (externalRef?: { kind: string; id: string }) =>
  ({ externalRef }) as unknown as LinkTimer;

describe("refOf", () => {
  test("names the issue by id, a label with its key and a link back", () => {
    expect(refOf({ id: "i1", key: "PX-1", title: "Fix it" })).toEqual({
      kind: ISSUE,
      id: "i1",
      label: "PX-1 Fix it",
      url: `${env.UI_ORIGIN}/issues/PX-1`,
    });
  });
});

describe("isOnIssue", () => {
  test("a timer on that issue is on it", () => {
    expect(isOnIssue(timer({ kind: ISSUE, id: "i1" }), "i1")).toBe(true);
  });

  test("no timer, no reference, another issue or another kind is not", () => {
    expect(isOnIssue(null, "i1")).toBe(false);
    expect(isOnIssue(undefined, "i1")).toBe(false);
    expect(isOnIssue(timer(), "i1")).toBe(false);
    expect(isOnIssue(timer({ kind: ISSUE, id: "i2" }), "i1")).toBe(false);
    expect(isOnIssue(timer({ kind: "task", id: "i1" }), "i1")).toBe(false);
  });
});

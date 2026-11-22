import { describe, expect, test } from "bun:test";
import type { IssueDocument } from "../issues.model";
import { orphanPatch } from "./orphan.utils";

const issue = (type?: string) => ({ type }) as unknown as IssueDocument;

describe("orphanPatch", () => {
  test("a Sub-task becomes a Task, the others only lose the parent", () => {
    expect(orphanPatch(issue("subTask"))).toEqual({
      parentId: null,
      type: "task",
    });
    expect(orphanPatch(issue("story"))).toEqual({ parentId: null });
    expect(orphanPatch(issue())).toEqual({ parentId: null });
  });
});

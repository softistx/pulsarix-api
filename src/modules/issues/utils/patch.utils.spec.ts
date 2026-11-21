import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
import type { IssueDocument } from "../issues.model";
import { failureOf, labelChanges, patchInput } from "./patch.utils";

const a = new ObjectId();
const b = new ObjectId();
const c = new ObjectId();

describe("failureOf", () => {
  test("a refusal becomes its code and message", () => {
    const error = new GraphQLError("No", {
      extensions: { code: "issues.errors.not-found" },
    });
    expect(failureOf("1", error)).toEqual({
      id: "1",
      code: "issues.errors.not-found",
      message: "No",
    });
    expect(failureOf("2", new GraphQLError("x")).code).toBe("unknown");
  });

  test("anything that is not a refusal goes on", () => {
    const boom = new Error("boom");
    expect(() => failureOf("1", boom)).toThrow(boom);
  });
});

describe("labelChanges", () => {
  test("the ids to add, and the hex ids to remove, each once", () => {
    const changes = labelChanges({
      addLabelIds: [a.toHexString(), a.toHexString()],
      removeLabelIds: [b.toHexString()],
    });
    expect(changes.add.map((id) => id.toHexString())).toEqual([
      a.toHexString(),
    ]);
    expect([...changes.remove]).toEqual([b.toHexString()]);
  });

  test("a patch with no labels changes none", () => {
    const changes = labelChanges({ priority: "low" });
    expect(changes.add).toEqual([]);
    expect(changes.remove.size).toBe(0);
  });
});

describe("patchInput", () => {
  const issue = { labelIds: [a, b] } as IssueDocument;

  test("only what the patch sets goes into the update", () => {
    expect(
      patchInput({ priority: "high", dueDate: null }, issue, [], new Set()),
    ).toEqual({ priority: "high", dueDate: null });
    expect(patchInput({}, issue, [], new Set())).toEqual({});
  });

  test("the labels are the issue's plus the added, minus the removed, once", () => {
    const patch = {
      addLabelIds: [c.toHexString(), a.toHexString()],
      removeLabelIds: [b.toHexString()],
    };
    const { add, remove } = labelChanges(patch);
    expect(patchInput(patch, issue, add, remove)).toEqual({
      labelIds: [a.toHexString(), c.toHexString()],
    });
  });
});

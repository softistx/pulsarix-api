import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IssueDocument } from "../issues.model";
import { isSet, newIssue, optionalId, updatedFields } from "./fields.utils";

const labelA = new ObjectId();
const place = {
  projectId: new ObjectId(),
  statusId: new ObjectId(),
  number: 7,
  key: "PX-7",
  rank: "m",
  planRank: "n",
  reporterId: "acc",
};

describe("isSet", () => {
  test("neither undefined nor null is set, falsy values are", () => {
    expect(isSet(undefined)).toBe(false);
    expect(isSet(null)).toBe(false);
    expect(isSet(0)).toBe(true);
    expect(isSet("")).toBe(true);
  });
});

describe("optionalId", () => {
  test("an empty id is no id, a hex id is an ObjectId", () => {
    expect(optionalId(null, "parentId")).toBeNull();
    expect(optionalId(undefined, "parentId")).toBeNull();
    expect(optionalId("", "parentId")).toBeNull();
    const hex = labelA.toHexString();
    expect(optionalId(hex, "parentId")?.toHexString()).toBe(hex);
  });

  test("a malformed id is refused on its path", () => {
    expect(() => optionalId("nope", "parentId")).toThrow();
  });
});

describe("newIssue", () => {
  test("defaults: trimmed title, no priority, a team origin, nothing set", () => {
    const made = newIssue({ projectId: "p", title: "  Fix  " }, place);
    expect(made).toMatchObject({
      title: "Fix",
      description: "",
      priority: "none",
      priorityLevel: 0,
      priorityOrigin: "team",
      assigneeId: null,
      labelIds: [],
      parentId: null,
      estimateHours: null,
      clientReportId: null,
      watcherIds: [],
      key: "PX-7",
      number: 7,
    });
  });

  test("the given fields are kept, the labels once each", () => {
    const hex = labelA.toHexString();
    const made = newIssue(
      {
        projectId: "p",
        title: "Fix",
        priority: "high",
        priorityOrigin: "client",
        labelIds: [hex, hex],
        estimateHours: 3,
      },
      place,
    );
    expect(made.priority).toBe("high");
    expect(made.priorityOrigin).toBe("client");
    expect(made.labelIds.map((id) => id.toHexString())).toEqual([hex]);
    expect(made.estimateHours).toBe(3);
  });
});

describe("updatedFields", () => {
  const issue = { priority: "low" } as IssueDocument;

  test("a field left out, or null where null is no value, stays", () => {
    expect(
      updatedFields({ title: null, description: null, priority: null }, issue),
    ).toEqual({});
    expect(updatedFields({ title: "   " }, issue)).toEqual({});
  });

  test("a nullable field given as null is cleared", () => {
    expect(
      updatedFields({ assigneeId: null, dueDate: null, parentId: null }, issue),
    ).toEqual({ assigneeId: null, dueDate: null, parentId: null });
  });

  test("a changed priority is the team's from then on, the same one is not", () => {
    expect(updatedFields({ priority: "high" }, issue)).toEqual({
      priority: "high",
      priorityLevel: 3,
      priorityOrigin: "team",
    });
    expect(updatedFields({ priority: "low" }, issue)).toEqual({
      priority: "low",
      priorityLevel: 1,
    });
  });

  test("the title and the description are trimmed", () => {
    expect(updatedFields({ title: " A ", description: " B " }, issue)).toEqual({
      title: "A",
      description: "B",
    });
  });
});

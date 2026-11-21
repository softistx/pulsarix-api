import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { ActivityDocument } from "./activity.model";
import { eventOf, issueEvent } from "./activity.utils";

describe("eventOf", () => {
  test("builds the event from the journal row and the issue", () => {
    const projectId = new ObjectId();
    const issueId = new ObjectId();
    const at = new Date("2026-01-02T03:04:05.000Z");
    const activity = {
      id: "act-1",
      verb: "updated",
      projectId,
      issueId,
      issueKey: "PX-1",
      actorId: "u-1",
      changes: [{ field: "title" }, { field: "priority" }],
      at,
    } as unknown as ActivityDocument;
    expect(eventOf("org-1", activity, { statusId: "s-1", rank: "a" })).toEqual({
      organisationId: "org-1",
      activityId: "act-1",
      verb: "updated",
      projectId: projectId.toHexString(),
      issueId: issueId.toHexString(),
      issueKey: "PX-1",
      actorId: "u-1",
      fields: ["title", "priority"],
      statusId: "s-1",
      rank: "a",
      at: "2026-01-02T03:04:05.000Z",
    });
  });
});

describe("issueEvent", () => {
  test("turns the stored time into a date", () => {
    const out = issueEvent({ at: "2026-01-02T03:04:05.000Z" });
    expect(out.at).toEqual(new Date("2026-01-02T03:04:05.000Z"));
  });
});

import { describe, expect, test } from "bun:test";
import { type NotifyEvent, recipientsOf } from "./notifications.rules";

const base: NotifyEvent = {
  verb: "commented",
  actorId: "actor",
  assigneeId: null,
  watcherIds: [],
  changes: [],
  mentionIds: [],
};
const of = (event: Partial<NotifyEvent>) =>
  Object.fromEntries(recipientsOf({ ...base, ...event }));

describe("who is told of an event", () => {
  test("a comment tells its mentions and the watchers, once each, the strongest reason first", () => {
    expect(of({ mentionIds: ["a", "b"], watcherIds: ["b", "c"] })).toEqual({
      a: "mention",
      b: "mention",
      c: "watchedChange",
    });
  });

  test("never the actor, whatever their part", () => {
    expect(
      of({
        mentionIds: ["actor", "a"],
        watcherIds: ["actor"],
        assigneeId: "actor",
      }),
    ).toEqual({ a: "mention" });
    expect(
      of({
        verb: "created",
        assigneeId: "actor",
      }),
    ).toEqual({});
  });

  test("an edit tells the mentions only", () => {
    expect(
      of({ verb: "commentEdited", mentionIds: ["a"], watcherIds: ["w"] }),
    ).toEqual({ a: "mention" });
  });

  test("a new issue tells its assignee", () => {
    expect(of({ verb: "created", assigneeId: "a", watcherIds: ["w"] })).toEqual(
      { a: "assigned" },
    );
  });

  test("a change tells the watchers; a new assignee is told they were assigned, not that it changed", () => {
    const changes = [{ field: "assigneeId", from: null, to: "a" }];
    expect(
      of({
        verb: "updated",
        assigneeId: "a",
        watcherIds: ["a", "w"],
        changes,
      }),
    ).toEqual({ a: "assigned", w: "watchedChange" });
    // An update that leaves the assignee alone does not tell them again.
    expect(
      of({
        verb: "updated",
        assigneeId: "a",
        watcherIds: ["w"],
        changes: [{ field: "title", from: "x", to: "y" }],
      }),
    ).toEqual({ w: "watchedChange" });
    expect(of({ verb: "moved", watcherIds: ["w"] })).toEqual({
      w: "watchedChange",
    });
  });

  test("unassigning tells nobody they were assigned", () => {
    expect(
      of({
        verb: "updated",
        assigneeId: null,
        changes: [{ field: "assigneeId", from: "a", to: null }],
      }),
    ).toEqual({});
  });

  test("deletions tell nobody", () => {
    for (const verb of ["deleted", "commentDeleted"] as const) {
      expect(of({ verb, watcherIds: ["w"], mentionIds: ["a"] })).toEqual({});
    }
  });
});

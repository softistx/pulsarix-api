import { describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import {
  comment,
  Delete,
  DeleteIssue,
  List,
  type Listing,
  setup,
} from "~/comments";
import { codeOf } from "~/http";

const kit = authApp();

describe("listing and cascade", () => {
  test("oldest first, paged by cursor, readable by a viewer", async () => {
    const { asMember, asViewer, issue } = await setup(kit);
    for (const text of ["one", "two", "three"])
      await comment(asMember, issue.id, text);
    const page1 = await asViewer.call<Listing>(List, {
      issueId: issue.id,
      first: 2,
    });
    expect(page1.comments.nodes.map((c) => c.body)).toEqual(["one", "two"]);
    expect(page1.comments.hasNextPage).toBe(true);
    const page2 = await asViewer.call<Listing>(List, {
      issueId: issue.id,
      first: 2,
      after: page1.comments.endCursor,
    });
    expect(page2.comments.nodes.map((c) => c.body)).toEqual(["three"]);
    expect(page2.comments.hasNextPage).toBe(false);
    expect(
      codeOf(await asViewer.attempt(List, { issueId: issue.id, first: 0 })),
    ).toBe("validation.errors.invalid-input");
  });

  test("deleting an issue deletes its comments", async () => {
    const { asMember, asOwner, issue } = await setup(kit);
    const added = await comment(asMember, issue.id, "gone soon");
    await asOwner.call(DeleteIssue, { id: issue.id });
    expect(codeOf(await asOwner.attempt(Delete, { id: added.id }))).toBe(
      "comments.errors.not-found",
    );
  });
});

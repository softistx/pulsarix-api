import { describe, expect, test } from "bun:test";
import { authApp, memberWith } from "~/auth";
import { type Comment, comment, Delete, Edit, setup } from "~/comments";
import { codeOf } from "~/http";

const kit = authApp();

describe("editing and deleting", () => {
  test("the author edits; the mentions are checked again and the edit is stamped", async () => {
    const { asMember, member, owner, issue } = await setup(kit);
    const added = await comment(asMember, issue.id, "first");
    const edited = await asMember.call<{ editComment: Comment }>(Edit, {
      id: added.id,
      input: { body: `now @[Boss](${owner.id})`, public: true },
    });
    expect(edited.editComment).toMatchObject({
      mentionIds: [owner.id],
      public: true,
      authorId: member.id,
    });
    expect(edited.editComment.editedAt).not.toBeNull();
    const bad = await asMember.attempt(Edit, {
      id: added.id,
      input: { body: "@[x](019a0000-0000-7000-8000-000000000002)" },
    });
    expect(codeOf(bad)).toBe("comments.errors.mention-not-member");
    expect(
      codeOf(await asMember.attempt(Edit, { id: added.id, input: {} })),
    ).toBe("validation.errors.invalid-input");
  });

  test("another member cannot edit or delete; an admin and the owner can", async () => {
    const { asMember, asAdmin, asOwner, as, organisation, owner, issue } =
      await setup(kit);
    const other = await memberWith(kit, organisation.id, owner.token, "member");
    const asOther = as(other.token);
    const added = await comment(asMember, issue.id, "mine");
    expect(
      codeOf(
        await asOther.attempt(Edit, { id: added.id, input: { body: "x" } }),
      ),
    ).toBe("comments.errors.not-yours");
    expect(codeOf(await asOther.attempt(Delete, { id: added.id }))).toBe(
      "comments.errors.not-yours",
    );
    const byAdmin = await asAdmin.call<{ editComment: Comment }>(Edit, {
      id: added.id,
      input: { body: "moderated" },
    });
    expect(byAdmin.editComment).toMatchObject({
      body: "moderated",
      authorId: added.authorId,
    });
    expect(
      (await asAdmin.call<{ deleteComment: string }>(Delete, { id: added.id }))
        .deleteComment,
    ).toBe(added.id);
    const mine = await comment(asMember, issue.id, "visible?");
    const flip = await asAdmin.attempt(Edit, {
      id: mine.id,
      input: { public: true },
    });
    expect(codeOf(flip)).toBe("comments.errors.public-author-only");
    const withBody = await asAdmin.attempt(Edit, {
      id: mine.id,
      input: { body: "moderated", public: true },
    });
    expect(codeOf(withBody)).toBe("comments.errors.public-author-only");
    expect(
      (
        await asMember.call<{ editComment: Comment }>(Edit, {
          id: mine.id,
          input: { public: true },
        })
      ).editComment.public,
    ).toBe(true);
    await asAdmin.call(Delete, { id: mine.id });
    const second = await comment(asMember, issue.id, "again");
    await asOwner.call(Delete, { id: second.id });
    const third = await comment(asMember, issue.id, "own");
    await asMember.call(Delete, { id: third.id });
    expect(codeOf(await asMember.attempt(Delete, { id: third.id }))).toBe(
      "comments.errors.not-found",
    );
  });
});

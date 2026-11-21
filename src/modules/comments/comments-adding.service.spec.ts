import { describe, expect, test } from "bun:test";
import { authApp, ownerWithOrganisation } from "~/auth";
import { Add, comment, List, type Listing, setup } from "~/comments";
import { codeOf } from "~/http";

const kit = authApp();

describe("adding comments", () => {
  test("a comment keeps its author, its flag and the members its markers name", async () => {
    const { asMember, member, owner, issue } = await setup(kit);
    const body = `Ping @[Ada](${owner.id}) and again @[Ada L.](${owner.id}), @[Me](${member.id})`;
    const added = await comment(asMember, issue.id, body);
    expect(added).toMatchObject({
      issueId: issue.id,
      authorId: member.id,
      body,
      mentionIds: [owner.id, member.id],
      public: false,
      editedAt: null,
    });
    expect(
      (await comment(asMember, issue.id, "hi", { public: true })).public,
    ).toBe(true);
  });

  test("a mention of a non-member is refused, whatever its label", async () => {
    const { asMember, issue, owner } = await setup(kit);
    const stranger = "019a0000-0000-7000-8000-000000000001";
    const failure = await asMember.attempt(Add, {
      issueId: issue.id,
      input: { body: `Hi @[${owner.id}](${stranger})` },
    });
    expect(codeOf(failure)).toBe("comments.errors.mention-not-member");
    // A member of another organisation is a stranger here too.
    const other = await ownerWithOrganisation(kit, "Other");
    const failure2 = await asMember.attempt(Add, {
      issueId: issue.id,
      input: { body: `@[Foreign](${other.owner.id})` },
    });
    expect(codeOf(failure2)).toBe("comments.errors.mention-not-member");
    const none = await asMember.call<Listing>(List, { issueId: issue.id });
    expect(none.comments.nodes).toEqual([]);
  });

  test("more than 50 distinct mentions are refused", async () => {
    const { asMember, issue } = await setup(kit);
    const body = Array.from({ length: 51 }, (_, i) => `@[a](id${i})`).join(" ");
    expect(
      codeOf(
        await asMember.attempt(Add, { issueId: issue.id, input: { body } }),
      ),
    ).toBe("validation.errors.invalid-input");
  });

  test("an empty body, an unknown issue and a viewer are refused", async () => {
    const { asMember, asViewer, issue } = await setup(kit);
    expect(
      codeOf(
        await asMember.attempt(Add, {
          issueId: issue.id,
          input: { body: "   " },
        }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(
        await asMember.attempt(Add, {
          issueId: "0123456789abcdef01234567",
          input: { body: "x" },
        }),
      ),
    ).toBe("issues.errors.not-found");
    expect(
      codeOf(
        await asViewer.attempt(Add, {
          issueId: issue.id,
          input: { body: "x" },
        }),
      ),
    ).toBe("auth.errors.forbidden");
  });
});

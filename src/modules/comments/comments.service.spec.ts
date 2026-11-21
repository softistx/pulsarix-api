import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

const fields = `id issueId authorId body mentionIds public editedAt`;
const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key }
}`;
const DeleteIssue = `mutation($id: ID!) { deleteIssue(id: $id) }`;
const Add = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { ${fields} }
}`;
const Edit = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { ${fields} }
}`;
const Delete = `mutation($id: ID!) { deleteComment(id: $id) }`;
const List = `query($issueId: ID!, $first: Int, $after: String) {
  comments(issueId: $issueId, first: $first, after: $after) {
    nodes { ${fields} } endCursor hasNextPage
  }
}`;

interface Comment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  mentionIds: string[];
  public: boolean;
  editedAt: string | null;
}
interface Listing {
  comments: {
    nodes: Comment[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const { createIssue: issue } = await asOwner.call<{
    createIssue: { id: string };
  }>(CreateIssue, { input: { projectId: project.id, title: "An issue" } });
  const member = await memberWith(kit, organisation.id, owner.token, "member");
  const admin = await memberWith(kit, organisation.id, owner.token, "admin");
  const viewer = await memberWith(kit, organisation.id, owner.token, "viewer");
  return {
    owner,
    organisation,
    asOwner,
    issue,
    member,
    admin,
    viewer,
    asMember: as(member.token),
    asAdmin: as(admin.token),
    asViewer: as(viewer.token),
    as,
  };
}

const comment = async (
  client: { call: <T>(q: string, v?: Record<string, unknown>) => Promise<T> },
  issueId: string,
  body: string,
  extra: Record<string, unknown> = {},
) =>
  (
    await client.call<{ addComment: Comment }>(Add, {
      issueId,
      input: { body, ...extra },
    })
  ).addComment;

describe("adding comments", () => {
  test("a comment keeps its author, its flag and the members its markers name", async () => {
    const { asMember, member, owner, issue } = await setup();
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
    const { asMember, issue, owner } = await setup();
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
    const { asMember, issue } = await setup();
    const body = Array.from({ length: 51 }, (_, i) => `@[a](id${i})`).join(" ");
    expect(
      codeOf(
        await asMember.attempt(Add, { issueId: issue.id, input: { body } }),
      ),
    ).toBe("validation.errors.invalid-input");
  });

  test("an empty body, an unknown issue and a viewer are refused", async () => {
    const { asMember, asViewer, issue } = await setup();
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

describe("editing and deleting", () => {
  test("the author edits; the mentions are checked again and the edit is stamped", async () => {
    const { asMember, member, owner, issue } = await setup();
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
      await setup();
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

describe("listing and cascade", () => {
  test("oldest first, paged by cursor, readable by a viewer", async () => {
    const { asMember, asViewer, issue } = await setup();
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
    const { asMember, asOwner, issue } = await setup();
    const added = await comment(asMember, issue.id, "gone soon");
    await asOwner.call(DeleteIssue, { id: issue.id });
    expect(codeOf(await asOwner.attempt(Delete, { id: added.id }))).toBe(
      "comments.errors.not-found",
    );
  });
});

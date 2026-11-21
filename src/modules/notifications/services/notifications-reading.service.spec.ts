import { describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { codeOf } from "~/http";
import {
  AddComment,
  Count,
  List,
  MarkRead,
  mention,
  type Row,
  setup,
} from "~/notifications";

const kit = authApp();

describe("notifications", () => {
  test("reading: unread filter, paging, marking some or all, and only one's own", async () => {
    const { owner, asOwner, as, issue, ada, bob, inbox } = await setup(kit);
    const created = await issue();
    for (const n of [1, 2, 3]) {
      await asOwner.call(AddComment, {
        issueId: created.id,
        input: { body: `${n} ${mention(ada.id)}` },
      });
    }
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(bob.id) },
    });
    const asAda = as(ada.token);

    const page = await asAda.call<{
      notifications: {
        nodes: Row[];
        endCursor: string | null;
        hasNextPage: boolean;
      };
    }>(List, { first: 2 });
    expect(page.notifications.nodes).toHaveLength(2);
    expect(page.notifications.hasNextPage).toBe(true);
    const rest = await asAda.call<{
      notifications: { nodes: Row[]; hasNextPage: boolean };
    }>(List, { first: 2, after: page.notifications.endCursor });
    expect(rest.notifications.nodes).toHaveLength(1);
    expect(rest.notifications.hasNextPage).toBe(false);

    const [first] = page.notifications.nodes;
    const [bobs] = await inbox(bob.token);
    // Marking one's own, and Bob's id (ignored), leaves two unread.
    const left = await asAda.call<{ markNotificationsRead: number }>(MarkRead, {
      ids: [first?.id, bobs?.id],
    });
    expect(left.markNotificationsRead).toBe(2);
    expect((await inbox(ada.token, true)).map((row) => row.id)).not.toContain(
      first?.id,
    );
    expect(await inbox(bob.token, true)).toHaveLength(1);

    const all = await asAda.call<{ markNotificationsRead: number }>(MarkRead);
    expect(all.markNotificationsRead).toBe(0);
    expect(await inbox(ada.token, true)).toEqual([]);
    expect(await inbox(ada.token)).toHaveLength(3);
    // Read ones keep their time.
    expect((await inbox(ada.token))[0]?.readAt).not.toBeNull();
    expect(await inbox(owner.token)).toEqual([]);
  });

  test("a bad page size or id is a validation error; an anonymous caller is refused", async () => {
    const { as, ada } = await setup(kit);
    expect(codeOf(await as(ada.token).attempt(List, { first: 0 }))).toBe(
      "validation.errors.invalid-input",
    );
    expect(
      codeOf(await as(ada.token).attempt(MarkRead, { ids: ["nope"] })),
    ).toBe("validation.errors.invalid-input");
    expect(codeOf(await kit.client(null).attempt(Count))).toBe(
      "auth.errors.unauthenticated",
    );
  });

  test("a member sees nothing of another organisation's notifications", async () => {
    const one = await setup(kit);
    const two = await setup(kit);
    const created = await one.issue();
    await one.asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(one.ada.id) },
    });
    expect(await one.inbox(one.ada.token)).toHaveLength(1);
    expect(await two.inbox(two.ada.token)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import {
  AddComment,
  Count,
  EditComment,
  mention,
  setup,
  UpdateIssue,
  Watch,
} from "~/notifications";

const kit = authApp();

describe("notifications", () => {
  test("a mention creates one notification and one live event, none for the author", async () => {
    const { owner, asOwner, as, issue, ada, inbox, live } = await setup(kit);
    const created = await issue("Fix the login");
    const stream = await live(ada.token);
    const own = await live(owner.token);

    const { addComment } = await asOwner.call<{ addComment: { id: string } }>(
      AddComment,
      {
        issueId: created.id,
        input: { body: `${mention(ada.id)} and @[me](${owner.id})` },
      },
    );

    const rows = await inbox(ada.token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "mention",
      issueKey: created.key,
      issueTitle: "Fix the login",
      actorId: owner.id,
      commentId: addComment.id,
      readAt: null,
    });
    const event = await stream.next();
    expect(event?.data?.notificationReceived).toEqual({
      notificationId: rows[0]?.id as string,
      kind: "mention",
      unreadCount: 1,
    });
    expect(await stream.quiet()).toBe(true);
    // The author mentioned themselves: nothing for them.
    expect(await inbox(owner.token)).toEqual([]);
    expect(await own.quiet()).toBe(true);
    expect(
      (await as(ada.token).call<{ unreadNotificationCount: number }>(Count))
        .unreadNotificationCount,
    ).toBe(1);
    await stream.close();
    await own.close();
  });

  test("each notification is delivered live to its recipient only, with the running unread count", async () => {
    const { asOwner, issue, ada, bob, live } = await setup(kit);
    const adaStream = await live(ada.token);
    const bobStream = await live(bob.token);

    const first = await issue("First", ada.id);
    await issue("Second", ada.id);

    const one = (await adaStream.next())?.data?.notificationReceived;
    const two = (await adaStream.next())?.data?.notificationReceived;
    expect(one).toMatchObject({ kind: "assigned", unreadCount: 1 });
    expect(two).toMatchObject({ kind: "assigned", unreadCount: 2 });
    expect(one?.notificationId).not.toBe(two?.notificationId);
    // Bob was not told, and nothing else follows for Ada.
    expect(await bobStream.quiet()).toBe(true);
    expect(await adaStream.quiet()).toBe(true);

    // A reassignment is delivered to the new assignee.
    await asOwner.call(UpdateIssue, {
      id: first.id,
      input: { assigneeId: bob.id },
    });
    expect((await bobStream.next())?.data?.notificationReceived).toMatchObject({
      kind: "assigned",
      unreadCount: 1,
    });
    await adaStream.close();
    await bobStream.close();
  });

  test("an edit that keeps a mention does not tell the member again; a new one does", async () => {
    const { asOwner, issue, ada, bob, inbox } = await setup(kit);
    const created = await issue();
    const { addComment } = await asOwner.call<{ addComment: { id: string } }>(
      AddComment,
      { issueId: created.id, input: { body: mention(ada.id) } },
    );
    await asOwner.call(EditComment, {
      id: addComment.id,
      input: { body: `${mention(ada.id)} please, and ${mention(bob.id)}` },
    });
    expect(await inbox(ada.token)).toHaveLength(1);
    const bobs = await inbox(bob.token);
    expect(bobs).toHaveLength(1);
    expect(bobs[0]?.kind).toBe("mention");
  });

  test("an assignment tells the assignee, whether at creation or later, but not the assigner", async () => {
    const { owner, asOwner, issue, ada, bob, inbox } = await setup(kit);
    await issue("Born assigned", ada.id);
    const later = await issue("Later");
    await asOwner.call(UpdateIssue, {
      id: later.id,
      input: { assigneeId: bob.id },
    });
    // Reassigning to the same person, or a title change, tells nobody new.
    await asOwner.call(UpdateIssue, {
      id: later.id,
      input: { assigneeId: bob.id, title: "Later, renamed" },
    });
    await issue("Self", owner.id);

    expect((await inbox(ada.token)).map((row) => row.kind)).toEqual([
      "assigned",
    ]);
    expect((await inbox(bob.token)).map((row) => row.kind)).toEqual([
      "assigned",
    ]);
    expect(await inbox(owner.token)).toEqual([]);
  });

  test("a watcher is told of a change and a comment, once per event, and never of their own", async () => {
    const { asOwner, as, issue, ada, inbox } = await setup(kit);
    const created = await issue("Watched");
    await as(ada.token).call(Watch, { id: created.id });

    await asOwner.call(UpdateIssue, {
      id: created.id,
      input: { priority: "high" },
    });
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: "A note" },
    });
    // Ada's own change: she is the actor.
    await as(ada.token).call(UpdateIssue, {
      id: created.id,
      input: { title: "Renamed" },
    });

    const rows = await inbox(ada.token);
    expect(rows.map((row) => row.kind)).toEqual([
      "watchedChange",
      "watchedChange",
    ]);
    expect(new Set(rows.map((row) => row.activityId)).size).toBe(2);
  });

  test("a mention that is also a watch is one notification, a mention", async () => {
    const { asOwner, as, issue, ada, inbox } = await setup(kit);
    const created = await issue();
    await as(ada.token).call(Watch, { id: created.id });
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(ada.id) },
    });
    const rows = await inbox(ada.token);
    expect(rows.map((row) => row.kind)).toEqual(["mention"]);
  });
});

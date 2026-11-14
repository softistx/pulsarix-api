import { describe, expect, test } from "bun:test";
import { createMemoryMailer } from "@softistx/mail";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { subscribe } from "~/sse";
import { tenancy } from "../../config/db";
import {
  DIGEST_DELAY_MS,
  type DigestDeps,
  type DigestJob,
  scheduleDigest,
  sendDigest,
  useDigestQueue,
} from "./notifications.digest";
import type { NotificationsMongo } from "./notifications.service";

const kit = authApp();

const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id }
}`;
const CreateIssue = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id key }
}`;
const UpdateIssue = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { id }
}`;
const Watch = `mutation($id: ID!) { watchIssue(id: $id) { id } }`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
const EditComment = `mutation($id: ID!, $input: EditCommentInput!) {
  editComment(id: $id, input: $input) { id }
}`;
const List = `query($unread: Boolean, $first: Int, $after: String) {
  notifications(unread: $unread, first: $first, after: $after) {
    nodes { id kind activityId issueKey issueTitle actorId commentId readAt }
    endCursor hasNextPage
  }
}`;
const Count = `query { unreadNotificationCount }`;
const MarkRead = `mutation($ids: [ID!]) { markNotificationsRead(ids: $ids) }`;
const Live = `subscription { notificationReceived { notificationId kind unreadCount } }`;

interface Row {
  id: string;
  kind: string;
  activityId: string;
  issueKey: string;
  issueTitle: string;
  actorId: string;
  commentId: string | null;
  readAt: string | null;
}

const mention = (id: string, label = "x") => `Hello @[${label}](${id})`;

async function setup() {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const as = (token: string) =>
    kit.client(token, { organisation: organisation.id });
  const asOwner = as(owner.token);
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string };
  }>(CreateProject, { input: { key: "ABC", name: "Alpha" } });
  const issue = async (title = "An issue", assigneeId?: string) =>
    (
      await asOwner.call<{ createIssue: { id: string; key: string } }>(
        CreateIssue,
        { input: { projectId: project.id, title, assigneeId } },
      )
    ).createIssue;
  const ada = await memberWith(kit, organisation.id, owner.token, "member");
  const bob = await memberWith(kit, organisation.id, owner.token, "member");
  const inbox = async (token: string, unread = false) =>
    (
      await as(token).call<{
        notifications: { nodes: Row[]; endCursor: string | null };
      }>(List, { unread })
    ).notifications.nodes;
  const live = (token: string) =>
    subscribe<{
      notificationReceived: {
        notificationId: string;
        kind: string;
        unreadCount: number;
      };
    }>(kit, token, { organisation: organisation.id }, Live);
  return {
    owner,
    organisation,
    project,
    asOwner,
    as,
    issue,
    ada,
    bob,
    inbox,
    live,
  };
}

describe("notifications", () => {
  test("a mention creates one notification and one live event, none for the author", async () => {
    const { owner, asOwner, as, issue, ada, inbox, live } = await setup();
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
    const { asOwner, issue, ada, bob, live } = await setup();
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
    const { asOwner, issue, ada, bob, inbox } = await setup();
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
    const { owner, asOwner, issue, ada, bob, inbox } = await setup();
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
    const { asOwner, as, issue, ada, inbox } = await setup();
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
    const { asOwner, as, issue, ada, inbox } = await setup();
    const created = await issue();
    await as(ada.token).call(Watch, { id: created.id });
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(ada.id) },
    });
    const rows = await inbox(ada.token);
    expect(rows.map((row) => row.kind)).toEqual(["mention"]);
  });

  test("reading: unread filter, paging, marking some or all, and only one's own", async () => {
    const { owner, asOwner, as, issue, ada, bob, inbox } = await setup();
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
    const { as, ada } = await setup();
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
    const one = await setup();
    const two = await setup();
    const created = await one.issue();
    await one.asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(one.ada.id) },
    });
    expect(await one.inbox(one.ada.token)).toHaveLength(1);
    expect(await two.inbox(two.ada.token)).toEqual([]);
  });
});

describe("the e-mail digest", () => {
  const queued = () => {
    const jobs: { data: DigestJob; id: string; delay: number }[] = [];
    const restore = useDigestQueue({
      add: async (data, options) => {
        const duplicate = jobs.some((job) => job.id === options.id);
        if (!duplicate) jobs.push({ data, ...options });
        return { deduplicated: duplicate };
      },
    });
    return { jobs, restore };
  };

  test("a notification schedules one delayed digest job per member and window", async () => {
    const { jobs, restore } = queued();
    try {
      const { asOwner, organisation, issue, ada, bob } = await setup();
      const created = await issue();
      for (const n of [1, 2]) {
        await asOwner.call(AddComment, {
          issueId: created.id,
          input: { body: `${n} ${mention(ada.id)} ${mention(bob.id)}` },
        });
      }
      const mine = jobs.filter(
        (job) => job.data.organisationId === organisation.id,
      );
      expect(mine.map((job) => job.data.recipientId).sort()).toEqual(
        [ada.id, bob.id].sort(),
      );
      expect(mine.every((job) => job.delay === DIGEST_DELAY_MS)).toBe(true);
    } finally {
      restore();
    }
  });

  test("no queue, no job, and no failure", async () => {
    const restore = useDigestQueue(undefined);
    try {
      await scheduleDigest("o", "r");
    } finally {
      restore();
    }
  });

  test("the digest mails what is unread and not yet mailed, in the member's language, once", async () => {
    const { owner, organisation, asOwner, as, issue, ada, bob } = await setup();
    const mailer = createMemoryMailer();
    const deps: DigestDeps = {
      mongo: async (id) =>
        (await tenancy.databaseOf(id)) as unknown as NotificationsMongo,
      organisationName: async () => "North Star",
      isMember: async (id, accountId) =>
        (await kit.auth.membership.roleOf(id, accountId)) !== null,
      accounts: async (ids) =>
        new Map(
          (await kit.auth.accounts.user.findMany(ids)).map((account) => [
            account.id,
            {
              name: account.name,
              email: account.email,
              locale: account.locale,
            },
          ]),
        ),
      mailer,
      from: { name: "pulsarix", address: "noreply@pulsarix.test" },
      uiOrigin: "https://ui.pulsarix.test",
    };
    const created = await issue("Fix the <login>");
    const other = await issue("Other");
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(ada.id) },
    });
    await asOwner.call(UpdateIssue, {
      id: other.id,
      input: { assigneeId: ada.id },
    });
    // Ada reads the first one meanwhile.
    const [newest, oldest] = (
      await as(ada.token).call<{ notifications: { nodes: Row[] } }>(List)
    ).notifications.nodes;
    await as(ada.token).call(MarkRead, { ids: [oldest?.id] });
    expect(newest?.kind).toBe("assigned");

    const job = { organisationId: organisation.id, recipientId: ada.id };
    expect(await sendDigest(deps, job)).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail?.subject).toBe("1 unread notification on North Star");
    expect(mail?.text).toContain(`assigned ${other.key} to you: Other`);
    expect(mail?.text).not.toContain(created.key);
    expect(mail?.text).toContain("https://ui.pulsarix.test/notifications");
    // Nothing left to mail: a second run is silent.
    expect(await sendDigest(deps, job)).toBe("nothing");
    expect(mailer.sent).toHaveLength(1);

    // Escaping in the HTML part.
    await asOwner.call(AddComment, {
      issueId: created.id,
      input: { body: mention(ada.id) },
    });
    await sendDigest(deps, job);
    expect(mailer.sent[1]?.html).toContain("Fix the &lt;login&gt;");

    // A member who left, or who has nothing, is not mailed.
    expect(
      await sendDigest(
        { ...deps, isMember: async () => false },
        { organisationId: organisation.id, recipientId: bob.id },
      ),
    ).toBe("skipped");
    expect(
      await sendDigest({ ...deps, organisationName: async () => null }, job),
    ).toBe("skipped");
    expect(owner.id).toBeString();
    expect(mailer.sent).toHaveLength(2);
  });
});

import { describe, expect, test } from "bun:test";
import { createMemoryMailer } from "@softistx/mail";
import { authApp } from "~/auth";
import {
  AddComment,
  List,
  MarkRead,
  mention,
  type Row,
  setup,
  UpdateIssue,
} from "~/notifications";
import { tenancy } from "../../../config/db";
import type { NotificationsMongo } from ".";
import {
  DIGEST_DELAY_MS,
  type DigestDeps,
  type DigestJob,
  scheduleDigest,
  sendDigest,
  useDigestQueue,
} from ".";

const kit = authApp();

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
      const { asOwner, organisation, issue, ada, bob } = await setup(kit);
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
    const { owner, organisation, asOwner, as, issue, ada, bob } =
      await setup(kit);
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

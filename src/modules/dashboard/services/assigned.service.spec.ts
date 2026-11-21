import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { DAY, Dashboard, type DashboardData, setup } from "~/dashboard";
import { codeOf } from "~/http";

type Page = DashboardData["dashboard"]["assigned"];

async function seeded() {
  const t = await setup();
  const day = t.startOfToday.getTime();
  const a = await t.project("AAA");
  const b = await t.project("BBB");
  const me = t.owner.id;
  const other = await t.member("member");
  const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1) + (n % 4) * DAY);
  const own = [
    ...(await a.issues("todo", 9, (n) => ({
      assigneeId: me,
      priorityLevel: n % 5,
      updatedAt: stamp(n),
      dueDate: n % 3 === 0 ? new Date(day - DAY) : null,
    }))),
    ...(await b.issues("inProgress", 11, (n) => ({
      assigneeId: me,
      priorityLevel: n % 3,
      updatedAt: stamp(0),
      dueDate: n % 4 === 0 ? new Date(day - 1) : new Date(day + DAY),
    }))),
  ];
  await a.issues("todo", 5, () => ({ assigneeId: other.id }));
  await a.issues("done", 4, () => ({ assigneeId: me }));
  await b.issues("cancelled", 2, () => ({ assigneeId: me }));
  const c = await t.project("CCC");
  await c.issues("todo", 3, () => ({ assigneeId: me }));
  await t.asOwner.call(
    `mutation($id: ID!) { archiveProject(id: $id) { id } }`,
    {
      id: c.id,
    },
  );
  return { t, own };
}

const pageOf = async (
  t: Awaited<ReturnType<typeof setup>>,
  first: number,
  after?: string | null,
): Promise<Page> =>
  (await t.asOwner.call<DashboardData>(Dashboard, { first, after })).dashboard
    .assigned;

describe("dashboard assigned", () => {
  test("pages through the open issues in order, no duplicate, no gap", async () => {
    const { t, own } = await seeded();
    const seen: Page["nodes"] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page: Page = await pageOf(t, 8, after);
      expect(page.totalCount).toBe(20);
      expect(page.lateCount).toBe(3 + 3);
      seen.push(...page.nodes);
      after = page.endCursor;
      pages += 1;
      expect(page.hasNextPage).toBe(pages < 3);
    } while (after);
    expect(pages).toBe(3);
    const ids = seen.map((n) => n.issue.id);
    expect(new Set(ids).size).toBe(20);
    expect([...ids].sort()).toEqual([...own].sort());
    // Late first, and none of the late ones after a not late one.
    const flags = seen.map((n) => n.late);
    expect(flags).toEqual([...flags].sort((x, y) => Number(y) - Number(x)));
    // Then priority, most recently updated, newest id: the whole keyset order.
    const docs = await t.mongo.db.issues.raw
      .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
      .toArray();
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    const key = (id: string) => {
      const d = byId.get(id);
      if (!d) throw new Error(id);
      const late = d.dueDate && d.dueDate.getTime() < t.startOfToday.getTime();
      return [
        late ? 1 : 0,
        d.priorityLevel,
        d.updatedAt.getTime(),
        id,
      ] as const;
    };
    const expected = [...ids].sort((x, y) => {
      const [a, b] = [key(x), key(y)];
      const at = a.findIndex((v, i) => v !== b[i]);
      if (at < 0) return 0;
      return (a[at] ?? 0) < (b[at] ?? 0) ? 1 : -1;
    });
    expect(ids).toEqual(expected);
    expect(
      seen.every((n) => ["AAA", "BBB"].some((k) => n.issue.key.startsWith(k))),
    ).toBe(true);
  });

  test("answers an empty page when nothing is assigned", async () => {
    const t = await setup();
    await t.project("AAA");
    const page = await pageOf(t, 8);
    expect(page).toEqual({
      nodes: [],
      totalCount: 0,
      lateCount: 0,
      endCursor: null,
      hasNextPage: false,
    });
  });

  test("refuses a size out of range, a garbled cursor and another day's", async () => {
    const { t } = await seeded();
    const refused = async (variables: Record<string, unknown>) =>
      codeOf(await t.asOwner.attempt(Dashboard, variables));
    expect(await refused({ first: 0 })).toBe("validation.errors.invalid-input");
    expect(await refused({ first: 101 })).toBe(
      "validation.errors.invalid-input",
    );
    expect(await refused({ first: 8, after: "not-a-cursor" })).toBe(
      "validation.errors.invalid-input",
    );
    const stale = Buffer.from(
      JSON.stringify([0, 0, 0, new ObjectId().toHexString(), "1999-01-01"]),
    ).toString("base64url");
    expect(await refused({ first: 8, after: stale })).toBe(
      "validation.errors.invalid-input",
    );
    expect(await refused({ latest: 0 })).toBe(
      "validation.errors.invalid-input",
    );
    expect(await refused({ latest: 21 })).toBe(
      "validation.errors.invalid-input",
    );
  });
});

describe("dashboard inbox", () => {
  test("counts the unread and shows the newest unread, else the newest", async () => {
    const t = await setup();
    const p = await t.project("AAA");
    const member = await t.member("member");
    const created = await t
      .as(member.token)
      .call<{ createIssue: { id: string } }>(
        `mutation($input: CreateIssueInput!) { createIssue(input: $input) { id } }`,
        { input: { projectId: p.id, title: "Mine", assigneeId: t.owner.id } },
      );
    expect(created.createIssue.id).toBeString();
    const template = await t.mongo.db.notifications.raw.findOne({
      recipientId: t.owner.id,
    });
    if (!template) throw new Error("no notification was made");
    const rows = Array.from({ length: 9 }, (_, n) => ({
      ...template,
      _id: new ObjectId(),
      dedupeKey: `spec:${n}`,
      readAt: n < 3 ? new Date() : null,
    }));
    await t.mongo.db.notifications.raw.insertMany(rows as never);
    const unread = [
      template._id,
      ...rows.filter((r) => !r.readAt).map((r) => r._id),
    ]
      .map((id) => id.toHexString())
      .sort()
      .reverse();

    const first = await t.asOwner.call<DashboardData>(Dashboard, { latest: 5 });
    expect(first.dashboard.inbox.unread).toBe(7);
    expect(first.dashboard.inbox.latest.map((n) => n.id)).toEqual(
      unread.slice(0, 5),
    );

    await t.asOwner.call(`mutation { markNotificationsRead }`);
    const read = (await t.asOwner.call<DashboardData>(Dashboard, { latest: 4 }))
      .dashboard.inbox;
    expect(read.unread).toBe(0);
    const every = [template._id, ...rows.map((r) => r._id)]
      .map((id) => id.toHexString())
      .sort()
      .reverse();
    expect(read.latest.map((n) => n.id)).toEqual(every.slice(0, 4));
  });
});

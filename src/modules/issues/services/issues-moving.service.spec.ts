import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { type Issue, List, type Listing, Move, withProject } from "~/issues";

describe("moving issues", () => {
  const order = async (
    t: Awaited<ReturnType<typeof withProject>>,
    statusId: string,
  ) =>
    (
      await t.asOwner.call<Listing>(List, {
        projectId: t.project.id,
        filter: { statusIds: [statusId] },
        sort: { field: "rank" },
        first: 100,
      })
    ).issues.nodes.map((n) => n.title);

  test("a move keeps the order of the others, between neighbours, at the ends and across statuses", async () => {
    const t = await withProject();
    const [a, b, c, d] = await Promise.all(
      ["A", "B", "C", "D"].map((title) => t.make(title)),
    );
    // Concurrent creation: take the actual order.
    const base = await order(t, t.backlog);
    expect([...base].sort()).toEqual(["A", "B", "C", "D"]);
    const byTitle = new Map(
      [a, b, c, d].map((issue) => [issue?.title, issue as Issue]),
    );
    const at = (title: string) => (byTitle.get(title) as Issue).id;
    const [w, x, y, z] = base as [string, string, string, string];

    // The last one goes between the first and the second.
    await t.asOwner.call(Move, {
      id: at(z),
      statusId: t.backlog,
      beforeId: at(w),
      afterId: at(x),
    });
    expect(await order(t, t.backlog)).toEqual([w, z, x, y]);
    // To the top (only `afterId`), to the end (neither), after one (only `beforeId`).
    await t.asOwner.call(Move, {
      id: at(y),
      statusId: t.backlog,
      afterId: at(w),
    });
    expect(await order(t, t.backlog)).toEqual([y, w, z, x]);
    await t.asOwner.call(Move, { id: at(y), statusId: t.backlog });
    expect(await order(t, t.backlog)).toEqual([w, z, x, y]);
    await t.asOwner.call(Move, {
      id: at(x),
      statusId: t.backlog,
      beforeId: at(w),
    });
    expect(await order(t, t.backlog)).toEqual([w, x, z, y]);

    // Across statuses: the column it leaves keeps its order, the new one gets it.
    const moved = await t.asOwner.call<{ moveIssue: Issue }>(Move, {
      id: at(z),
      statusId: t.inProgress,
    });
    expect(moved.moveIssue.statusId).toBe(t.inProgress);
    expect(await order(t, t.backlog)).toEqual([w, x, y]);
    expect(await order(t, t.inProgress)).toEqual([z]);
    await t.asOwner.call(Move, {
      id: at(y),
      statusId: t.inProgress,
      beforeId: at(z),
    });
    expect(await order(t, t.inProgress)).toEqual([z, y]);
  });

  test("issues put again and again at the top, or into the same gap, keep a strict order", async () => {
    const t = await withProject();
    const first = await t.make("n0");
    const last = await t.make("last");
    let top = first.id;
    const atTop = ["n0"];
    for (let i = 1; i <= 25; i++) {
      const made = await t.make(`n${i}`);
      await t.asOwner.call(Move, {
        id: made.id,
        statusId: t.backlog,
        afterId: top,
      });
      top = made.id;
      atTop.unshift(`n${i}`);
    }
    // Every one of them goes into the gap right after `last`'s predecessor.
    expect(await order(t, t.backlog)).toEqual([...atTop, "last"]);
    const gap = await t.make("gap0");
    await t.asOwner.call(Move, {
      id: gap.id,
      statusId: t.backlog,
      beforeId: first.id,
      afterId: last.id,
    });
    const inserted = ["gap0"];
    for (let i = 1; i <= 25; i++) {
      const made = await t.make(`gap${i}`);
      await t.asOwner.call(Move, {
        id: made.id,
        statusId: t.backlog,
        beforeId: first.id,
        afterId: last.id,
      });
      inserted.unshift(`gap${i}`);
    }
    const all = await order(t, t.backlog);
    expect(all.slice(all.indexOf("n0"))).toEqual(["n0", ...inserted, "last"]);
  });

  test("neighbours outside the column or out of order are refused", async () => {
    const t = await withProject();
    const a = await t.make("A");
    const b = await t.make("B");
    const c = await t.make("C", { statusId: t.todo });
    const bad = async (input: Record<string, unknown>) =>
      codeOf(await t.asOwner.attempt(Move, input));
    expect(await bad({ id: a.id, statusId: t.backlog, beforeId: c.id })).toBe(
      "issues.errors.bad-placement",
    );
    expect(await bad({ id: a.id, statusId: t.backlog, afterId: a.id })).toBe(
      "issues.errors.bad-placement",
    );
    expect(await bad({ id: a.id, statusId: t.todo, beforeId: b.id })).toBe(
      "issues.errors.bad-placement",
    );
    // B is below A: A "after B and before A's own successor" is out of order.
    expect(
      await bad({
        id: c.id,
        statusId: t.backlog,
        beforeId: b.id,
        afterId: a.id,
      }),
    ).toBe("issues.errors.bad-placement");
    expect(await bad({ id: a.id, statusId: "0".repeat(24) })).toBe(
      "validation.errors.invalid-input",
    );
  });
});

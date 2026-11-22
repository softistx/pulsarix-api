import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { List, type Listing, listingFixture, withProject } from "~/issues";

describe("listing issues", () => {
  test("filters narrow the list", async () => {
    const { t, lid, a } = await listingFixture();

    expect(await t.titles()).toEqual([
      "Alpha login",
      "Beta export",
      "Gamma [x]",
      "Delta",
    ]);
    expect(await t.titles({ statusIds: [t.todo, t.done] })).toEqual([
      "Beta export",
      "Gamma [x]",
    ]);
    expect(await t.titles({ categories: ["done"] })).toEqual(["Gamma [x]"]);
    expect(await t.titles({ priorities: ["low", "high"] })).toEqual([
      "Alpha login",
      "Gamma [x]",
    ]);
    expect(await t.titles({ assigneeId: t.owner.id })).toEqual(["Alpha login"]);
    expect(await t.titles({ unassigned: true })).toHaveLength(3);
    expect(await t.titles({ labelIds: [lid] })).toEqual(["Alpha login"]);
    expect(await t.titles({ parentId: a.id })).toEqual(["Gamma [x]"]);
    expect(await t.titles({ rootsOnly: true })).toHaveLength(3);
    expect(await t.titles({ types: ["epic"] })).toEqual(["Alpha login"]);
    expect(await t.titles({ types: ["task"] })).toHaveLength(3);
    expect(await t.titles({ reporterId: t.owner.id })).toHaveLength(4);
    expect(await t.titles({ watching: true })).toEqual(["Alpha login"]);
    expect(await t.titles({ text: "EXPORT" })).toEqual(["Beta export"]);
    expect(await t.titles({ text: "[x]" })).toEqual(["Gamma [x]"]);
    expect(
      await t.titles({
        dueAfter: "2026-03-05T00:00:00Z",
        dueBefore: "2026-03-31T00:00:00Z",
      }),
    ).toEqual(["Alpha login"]);
    expect(
      await t.titles({ statusIds: [t.todo], priorities: ["low"] }),
    ).toEqual([]);
  });

  test("sorts order the list", async () => {
    const { t } = await listingFixture();

    expect(
      await t.titles(undefined, { field: "title", direction: "desc" }),
    ).toEqual(["Gamma [x]", "Delta", "Beta export", "Alpha login"]);
    expect(
      await t.titles(undefined, { field: "priority", direction: "desc" }),
    ).toEqual(["Beta export", "Gamma [x]", "Alpha login", "Delta"]);
    expect(
      await t.titles(undefined, { field: "number", direction: "desc" }),
    ).toEqual(["Delta", "Gamma [x]", "Beta export", "Alpha login"]);
    expect(
      (await t.titles(undefined, { field: "dueDate", direction: "asc" })).slice(
        -2,
      ),
    ).toEqual(["Beta export", "Alpha login"]);
  });

  test("pages follow by cursor and bad paging input is refused", async () => {
    const { t } = await listingFixture();

    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page: Listing = await t.asOwner.call<Listing>(List, {
        projectId: t.project.id,
        first: 3,
        after,
        sort: { field: "title", direction: "asc" },
      });
      seen.push(...page.issues.nodes.map((n) => n.title));
      after = page.issues.endCursor;
      pages++;
      expect(page.issues.hasNextPage).toBe(after !== null);
    } while (after);
    expect(pages).toBe(2);
    expect(seen).toEqual(["Alpha login", "Beta export", "Delta", "Gamma [x]"]);

    for (const variables of [
      { first: 0 },
      { first: 101 },
      { after: "not-a-cursor" },
      { projectId: "nope" },
    ]) {
      expect(
        codeOf(
          await t.asOwner.attempt(List, {
            projectId: t.project.id,
            ...variables,
          }),
        ),
      ).toBe("validation.errors.invalid-input");
    }
  });
});

describe("paging on optional fields", () => {
  test("a due-date sort pages through set and null dates, each issue once, and a cursor is bound to its list", async () => {
    const t = await withProject();
    for (const [title, dueDate] of [
      ["a", "2026-03-03T00:00:00Z"],
      ["b", null],
      ["c", "2026-03-01T00:00:00Z"],
      ["d", null],
      ["e", "2026-03-02T00:00:00Z"],
    ] as const) {
      await t.make(title, dueDate ? { dueDate } : {});
    }
    for (const direction of ["asc", "desc"]) {
      const seen: string[] = [];
      let after: string | null = null;
      do {
        const page: Listing = await t.asOwner.call<Listing>(List, {
          projectId: t.project.id,
          first: 2,
          after,
          sort: { field: "dueDate", direction },
        });
        seen.push(...page.issues.nodes.map((n) => n.title));
        after = page.issues.endCursor;
      } while (after);
      expect([...seen].sort()).toEqual(["a", "b", "c", "d", "e"]);
    }
    const first = await t.asOwner.call<Listing>(List, {
      projectId: t.project.id,
      first: 2,
      sort: { field: "dueDate", direction: "asc" },
    });
    const other = await t.asOwner.attempt(List, {
      projectId: t.project.id,
      first: 2,
      after: first.issues.endCursor,
      sort: { field: "dueDate", direction: "asc" },
      filter: { priorities: ["low"] },
    });
    expect(codeOf(other)).toBe("validation.errors.invalid-input");
  });
});

import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";

const kit = authApp();

const fields = `id projectId number key title description statusId priority
  assigneeId labelIds parentId startDate dueDate rank reporterId watcherIds
  watching`;
const CreateProject = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { id key statuses { id name category } }
}`;
const CreateLabel = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { id }
}`;
const DeleteLabel = `mutation($id: ID!) { deleteLabel(id: $id) }`;
const DeleteStatus = `mutation($id: ID!) { deleteStatus(id: $id) }`;
const Create = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { ${fields} }
}`;
const Update = `mutation($id: ID!, $input: UpdateIssueInput!) {
  updateIssue(id: $id, input: $input) { ${fields} }
}`;
const Move = `mutation($id: ID!, $statusId: ID!, $beforeId: ID, $afterId: ID) {
  moveIssue(id: $id, statusId: $statusId, beforeId: $beforeId, afterId: $afterId) { ${fields} }
}`;
const Delete = `mutation($id: ID!) { deleteIssue(id: $id) }`;
const Watch = `mutation($id: ID!) { watchIssue(id: $id) { watcherIds watching } }`;
const Unwatch = `mutation($id: ID!) { unwatchIssue(id: $id) { watcherIds watching } }`;
const ByKey = `query($key: String!) { issue(key: $key) { ${fields} } }`;
const List = `query($projectId: ID!, $filter: IssueFilter, $sort: IssueSort, $first: Int, $after: String) {
  issues(projectId: $projectId, filter: $filter, sort: $sort, first: $first, after: $after) {
    nodes { id key title rank } endCursor hasNextPage
  }
}`;

interface Issue {
  id: string;
  key: string;
  number: number;
  title: string;
  statusId: string;
  rank: string;
  labelIds: string[];
  parentId: string | null;
  assigneeId: string | null;
  reporterId: string | null;
  priority: string;
  dueDate: string | null;
  startDate: string | null;
  watcherIds: string[];
  watching: boolean;
}
interface Project {
  id: string;
  key: string;
  statuses: { id: string; name: string; category: string }[];
}
interface Listing {
  issues: {
    nodes: { id: string; key: string; title: string }[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

async function withProject(key = "ABC") {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: Project;
  }>(CreateProject, { input: { key, name: "Alpha" } });
  const [triage, backlog, todo, inProgress, done] = project.statuses.map(
    (s) => s.id,
  ) as [string, string, string, string, string];
  const make = async (title: string, extra: Record<string, unknown> = {}) =>
    (
      await asOwner.call<{ createIssue: Issue }>(Create, {
        input: { projectId: project.id, title, ...extra },
      })
    ).createIssue;
  const titles = async (
    filter?: Record<string, unknown>,
    sort?: Record<string, unknown>,
  ) =>
    (
      await asOwner.call<Listing>(List, {
        projectId: project.id,
        filter,
        sort,
      })
    ).issues.nodes.map((n) => n.title);
  return {
    owner,
    organisation,
    asOwner,
    project,
    triage,
    backlog,
    todo,
    inProgress,
    done,
    make,
    titles,
  };
}

describe("creating issues", () => {
  test("an issue lands in Backlog with the next number, a key and the reporter", async () => {
    const { asOwner, project, backlog, owner, make } = await withProject();
    const first = await make("First");
    expect(first).toMatchObject({
      number: 1,
      key: "ABC-1",
      statusId: backlog,
      priority: "none",
      reporterId: owner.id,
      labelIds: [],
      parentId: null,
      watcherIds: [],
      watching: false,
    });
    expect((await make("Second")).key).toBe("ABC-2");
    const read = await asOwner.call<{ issue: Issue }>(ByKey, { key: "abc-1" });
    expect(read.issue.id).toBe(first.id);
    expect(codeOf(await asOwner.attempt(ByKey, { key: "ABC-99" }))).toBe(
      "issues.errors.not-found",
    );
    // Another project counts on its own.
    const other = await asOwner.call<{ createProject: Project }>(
      CreateProject,
      { input: { key: "BET", name: "Beta" } },
    );
    const beta = await asOwner.call<{ createIssue: Issue }>(Create, {
      input: { projectId: other.createProject.id, title: "B" },
    });
    expect(beta.createIssue.key).toBe("BET-1");
    expect(project.key).toBe("ABC");
  });

  test("numbers made at once have no gap and no duplicate", async () => {
    const { asOwner, project } = await withProject();
    const count = 24;
    const made = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        asOwner.call<{ createIssue: Issue }>(Create, {
          input: { projectId: project.id, title: `Issue ${i}` },
        }),
      ),
    );
    const numbers = made.map((m) => m.createIssue.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(new Set(made.map((m) => m.createIssue.rank)).size).toBe(count);
    const listed = await asOwner.call<Listing>(List, {
      projectId: project.id,
      first: 100,
    });
    expect(listed.issues.nodes.map((n) => n.key)).toEqual(
      Array.from({ length: count }, (_, i) => `ABC-${i + 1}`),
    );
  });

  test("a deleted issue's number is not given again", async () => {
    const { asOwner, make } = await withProject();
    await make("One");
    const two = await make("Two");
    await asOwner.call(Delete, { id: two.id });
    expect((await make("Three")).key).toBe("ABC-3");
  });

  test("references are checked against the project and the members", async () => {
    const { asOwner, project, make, owner } = await withProject();
    const other = await withProject("OTH");
    const label = await asOwner.call<{ createLabel: { id: string } }>(
      CreateLabel,
      {
        input: { projectId: project.id, name: "bug", colour: "#ff0000" },
      },
    );
    const foreignLabel = await other.asOwner.call<{
      createLabel: { id: string };
    }>(CreateLabel, {
      input: { projectId: other.project.id, name: "bug", colour: "#ff0000" },
    });
    const foreign = await other.make("Elsewhere");
    const stranger = await withProject("STR");

    const refused = async (extra: Record<string, unknown>, path: string) => {
      const answer = await asOwner.attempt(Create, {
        input: { projectId: project.id, title: "X", ...extra },
      });
      expect(codeOf(answer)).toBe("validation.errors.invalid-input");
      expect(answer.errors?.[0]?.extensions?.fields?.[0]?.path).toBe(path);
    };
    await refused({ statusId: other.backlog }, "statusId");
    await refused({ labelIds: [foreignLabel.createLabel.id] }, "labelIds");
    await refused({ parentId: foreign.id }, "parentId");
    await refused({ assigneeId: stranger.owner.id }, "assigneeId");
    await refused(
      { startDate: "2026-03-02T00:00:00Z", dueDate: "2026-03-01T00:00:00Z" },
      "dueDate",
    );
    await refused({ title: "   " }, "title");
    expect(
      codeOf(
        await asOwner.attempt(Create, {
          input: { projectId: "0".repeat(24), title: "X" },
        }),
      ),
    ).toBe("projects.errors.not-found");

    const full = await make("Full", {
      priority: "urgent",
      assigneeId: owner.id,
      labelIds: [label.createLabel.id, label.createLabel.id],
      startDate: "2026-03-01T00:00:00Z",
      dueDate: "2026-03-09T00:00:00Z",
    });
    expect(full).toMatchObject({
      priority: "urgent",
      assigneeId: owner.id,
      labelIds: [label.createLabel.id],
    });
    expect(full.dueDate).toBe("2026-03-09T00:00:00.000Z");
  });
});

describe("updating issues", () => {
  test("fields left out stay; null clears the optional ones and is refused for the rest", async () => {
    const { asOwner, make, owner } = await withProject();
    const parent = await make("Parent");
    const child = await make("Child", {
      assigneeId: owner.id,
      parentId: parent.id,
      dueDate: "2026-03-09T00:00:00Z",
    });
    const changed = await asOwner.call<{ updateIssue: Issue }>(Update, {
      id: child.id,
      input: { title: "Child 2", priority: "high" },
    });
    expect(changed.updateIssue).toMatchObject({
      title: "Child 2",
      priority: "high",
      assigneeId: owner.id,
      parentId: parent.id,
      dueDate: "2026-03-09T00:00:00.000Z",
    });
    const cleared = await asOwner.call<{ updateIssue: Issue }>(Update, {
      id: child.id,
      input: { assigneeId: null, parentId: null, dueDate: null },
    });
    expect(cleared.updateIssue).toMatchObject({
      assigneeId: null,
      parentId: null,
      dueDate: null,
      title: "Child 2",
    });
    for (const input of [{ title: null }, { priority: null }, { title: "" }]) {
      expect(
        codeOf(await asOwner.attempt(Update, { id: child.id, input })),
      ).toBe("validation.errors.invalid-input");
    }
    // A date is checked against the one already stored.
    await asOwner.call(Update, {
      id: child.id,
      input: { startDate: "2026-03-05T00:00:00Z" },
    });
    expect(
      codeOf(
        await asOwner.attempt(Update, {
          id: child.id,
          input: { dueDate: "2026-03-01T00:00:00Z" },
        }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(
        await asOwner.attempt(Update, {
          id: "0".repeat(24),
          input: { title: "x" },
        }),
      ),
    ).toBe("issues.errors.not-found");
  });

  test("a parent may not loop back; deleting a parent frees its children", async () => {
    const { asOwner, make, project } = await withProject();
    const a = await make("A");
    const b = await make("B", { parentId: a.id });
    const c = await make("C", { parentId: b.id });
    for (const [id, parentId] of [
      [a.id, a.id],
      [a.id, c.id],
    ] as const) {
      expect(
        codeOf(await asOwner.attempt(Update, { id, input: { parentId } })),
      ).toBe("issues.errors.parent-cycle");
    }
    await asOwner.call(Delete, { id: b.id });
    const kept = await asOwner.call<{ issue: Issue }>(ByKey, { key: c.key });
    expect(kept.issue.parentId).toBeNull();
    expect(project.key).toBe("ABC");
  });

  test("watching is repeatable and personal", async () => {
    const { asOwner, make, owner, organisation } = await withProject();
    const issue = await make("Watched");
    const member = await memberWith(
      kit,
      organisation.id,
      owner.token,
      "member",
    );
    const asMember = kit.client(member.token, {
      organisation: organisation.id,
    });

    const first = await asOwner.call<{
      watchIssue: { watcherIds: string[]; watching: boolean };
    }>(Watch, { id: issue.id });
    expect(first.watchIssue).toEqual({
      watcherIds: [owner.id],
      watching: true,
    });
    await asOwner.call(Watch, { id: issue.id });
    const both = await asMember.call<{
      watchIssue: { watcherIds: string[]; watching: boolean };
    }>(Watch, { id: issue.id });
    expect(both.watchIssue.watcherIds.sort()).toEqual(
      [owner.id, member.id].sort(),
    );
    const gone = await asOwner.call<{
      unwatchIssue: { watcherIds: string[]; watching: boolean };
    }>(Unwatch, { id: issue.id });
    expect(gone.unwatchIssue).toEqual({
      watcherIds: [member.id],
      watching: false,
    });
    await asOwner.call(Unwatch, { id: issue.id });
  });
});

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

async function listingFixture() {
  const t = await withProject();
  const label = await t.asOwner.call<{ createLabel: { id: string } }>(
    CreateLabel,
    { input: { projectId: t.project.id, name: "bug", colour: "#ff0000" } },
  );
  const lid = label.createLabel.id;
  const a = await t.make("Alpha login", {
    priority: "low",
    assigneeId: t.owner.id,
    labelIds: [lid],
    dueDate: "2026-03-10T00:00:00Z",
  });
  await t.make("Beta export", {
    priority: "urgent",
    statusId: t.todo,
    dueDate: "2026-03-01T00:00:00Z",
  });
  await t.make("Gamma [x]", {
    priority: "high",
    statusId: t.done,
    parentId: a.id,
  });
  await t.make("Delta", {});
  await t.asOwner.call(Watch, { id: a.id });
  return { t, lid, a };
}

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

describe("issues and the workflow", () => {
  test("a status with issues cannot be deleted; an emptied one can", async () => {
    const t = await withProject();
    const issue = await t.make("Stays", { statusId: t.todo });
    expect(codeOf(await t.asOwner.attempt(DeleteStatus, { id: t.todo }))).toBe(
      "projects.errors.status-in-use",
    );
    await t.asOwner.call(Move, { id: issue.id, statusId: t.done });
    await t.asOwner.call(DeleteStatus, { id: t.todo });
  });

  test("a deleted label leaves the issues that carried it", async () => {
    const t = await withProject();
    const make = (name: string) =>
      t.asOwner.call<{ createLabel: { id: string } }>(CreateLabel, {
        input: { projectId: t.project.id, name, colour: "#00ff00" },
      });
    const bug = (await make("bug")).createLabel.id;
    const area = (await make("area")).createLabel.id;
    const issue = await t.make("Tagged", { labelIds: [bug, area] });
    await t.asOwner.call(DeleteLabel, { id: bug });
    const read = await t.asOwner.call<{ issue: Issue }>(ByKey, {
      key: issue.key,
    });
    expect(read.issue.labelIds).toEqual([area]);
  });
});

describe("who may do what", () => {
  test("members write, viewers read, only admins delete, a stranger sees nothing", async () => {
    const t = await withProject();
    const issue = await t.make("Shared");
    const as = async (role: "admin" | "member" | "viewer") => {
      const m = await memberWith(kit, t.organisation.id, t.owner.token, role);
      return kit.client(m.token, { organisation: t.organisation.id });
    };
    const [admin, member, viewer] = [
      await as("admin"),
      await as("member"),
      await as("viewer"),
    ];

    const made = await member.call<{ createIssue: Issue }>(Create, {
      input: { projectId: t.project.id, title: "By member" },
    });
    await member.call(Update, {
      id: made.createIssue.id,
      input: { title: "Renamed" },
    });
    await member.call(Move, { id: made.createIssue.id, statusId: t.todo });
    expect(codeOf(await member.attempt(Delete, { id: issue.id }))).toBe(
      "auth.errors.forbidden",
    );

    for (const [query, variables] of [
      [Create, { input: { projectId: t.project.id, title: "X" } }],
      [Update, { id: issue.id, input: { title: "X" } }],
      [Move, { id: issue.id, statusId: t.todo }],
      [Watch, { id: issue.id }],
      [Delete, { id: issue.id }],
    ] as const) {
      expect(codeOf(await viewer.attempt(query, variables))).toBe(
        "auth.errors.forbidden",
      );
    }
    const read = await viewer.call<Listing>(List, { projectId: t.project.id });
    expect(read.issues.nodes).toHaveLength(2);
    expect(
      (await viewer.call<{ issue: Issue }>(ByKey, { key: "ABC-1" })).issue.id,
    ).toBe(issue.id);

    await admin.call(Delete, { id: issue.id });
    expect(codeOf(await t.asOwner.attempt(ByKey, { key: "ABC-1" }))).toBe(
      "issues.errors.not-found",
    );

    // Another organisation does not see this organisation's issues.
    const other = await withProject("ABC");
    expect(codeOf(await other.asOwner.attempt(ByKey, { key: "ABC-2" }))).toBe(
      "issues.errors.not-found",
    );
    expect(
      codeOf(
        await other.asOwner.attempt(Update, {
          id: made.createIssue.id,
          input: { title: "x" },
        }),
      ),
    ).toBe("issues.errors.not-found");
  });
});

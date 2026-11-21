import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import {
  ByKey,
  Create,
  CreateLabel,
  CreateProject,
  Delete,
  type Issue,
  List,
  type Listing,
  type Project,
  withProject,
} from "~/issues";

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

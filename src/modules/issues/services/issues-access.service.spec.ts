import { describe, expect, test } from "bun:test";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import {
  ByKey,
  Create,
  CreateLabel,
  Delete,
  DeleteLabel,
  DeleteStatus,
  type Issue,
  kit,
  List,
  type Listing,
  Move,
  Update,
  Watch,
  withProject,
} from "~/issues";

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

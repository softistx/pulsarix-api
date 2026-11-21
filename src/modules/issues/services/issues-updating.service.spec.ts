import { describe, expect, test } from "bun:test";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import {
  ByKey,
  Delete,
  type Issue,
  kit,
  Unwatch,
  Update,
  Watch,
  withProject,
} from "~/issues";

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

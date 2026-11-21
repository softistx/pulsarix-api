import { describe, expect, test } from "bun:test";
import { authApp, memberWith } from "~/auth";
import { codeOf } from "~/http";
import {
  ByKey,
  CreateStatus,
  DeleteLabel,
  DeleteStatus,
  type Project,
  Reorder,
  UpdateStatus,
  withProject,
} from "~/projects";
import { registerStatusUsage } from "../public";

const kit = authApp();

describe("statuses", () => {
  test("a status is added at the end, renamed and recoloured; names are unique", async () => {
    const { asOwner, project } = await withProject(kit);
    const input = {
      projectId: project.id,
      name: "Review",
      category: "inProgress",
      colour: "#112233",
    };
    const created = await asOwner.call<{
      createStatus: { id: string; order: number };
    }>(CreateStatus, { input });
    expect(created.createStatus.order).toBe(6);
    expect(codeOf(await asOwner.attempt(CreateStatus, { input }))).toBe(
      "projects.errors.status-name-taken",
    );
    expect(
      codeOf(
        await asOwner.attempt(CreateStatus, {
          input: { ...input, name: "Bad", colour: "red" },
        }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(
        await asOwner.attempt(CreateStatus, {
          input: { ...input, projectId: "0".repeat(24) },
        }),
      ),
    ).toBe("projects.errors.not-found");

    const renamed = await asOwner.call<{
      updateStatus: { name: string; colour: string; category: string };
    }>(UpdateStatus, {
      id: created.createStatus.id,
      input: { name: "QA", colour: "#abcdef" },
    });
    expect(renamed.updateStatus).toMatchObject({
      name: "QA",
      colour: "#abcdef",
      category: "inProgress",
    });
    expect(
      codeOf(
        await asOwner.attempt(UpdateStatus, {
          id: created.createStatus.id,
          input: { name: "Todo" },
        }),
      ),
    ).toBe("projects.errors.status-name-taken");
  });

  test("reordering takes every status once, and the order is kept", async () => {
    const { asOwner, project } = await withProject(kit);
    const ids = project.statuses.map((s) => s.id);
    const reversed = [...ids].reverse();
    const done = await asOwner.call<{
      reorderStatuses: { id: string; order: number }[];
    }>(Reorder, { projectId: project.id, ids: reversed });
    expect(done.reorderStatuses.map((s) => [s.id, s.order])).toEqual(
      reversed.map((id, order) => [id, order]),
    );
    const read = await asOwner.call<{ project: Project }>(ByKey, {
      key: project.key,
    });
    expect(read.project.statuses.map((s) => s.id)).toEqual(reversed);

    for (const bad of [
      ids.slice(1),
      [...ids, ids[0]],
      [...ids.slice(1), "0".repeat(24)],
    ]) {
      expect(
        codeOf(
          await asOwner.attempt(Reorder, { projectId: project.id, ids: bad }),
        ),
      ).toBe("validation.errors.invalid-input");
    }
  });

  test("a status in use is refused with 409; an unused one goes and the gap closes", async () => {
    const { asOwner, project } = await withProject(kit);
    const [, backlog, todo] = project.statuses;
    // What the issues module (A3) will register.
    const release = registerStatusUsage(async (_, id) => id === todo?.id);
    try {
      const refused = await asOwner.attempt(DeleteStatus, { id: todo?.id });
      expect(codeOf(refused)).toBe("projects.errors.status-in-use");

      const gone = await asOwner.call<{ deleteStatus: string }>(DeleteStatus, {
        id: backlog?.id,
      });
      expect(gone.deleteStatus).toBe(backlog?.id as string);
    } finally {
      release();
    }
    const read = await asOwner.call<{ project: Project }>(ByKey, {
      key: project.key,
    });
    expect(read.project.statuses.map((s) => [s.name, s.order])).toEqual([
      ["Triage", 0],
      ["Todo", 1],
      ["In progress", 2],
      ["Done", 3],
      ["Cancelled", 4],
    ]);
    // Once nothing registers a usage, the status goes.
    await asOwner.call(DeleteStatus, { id: todo?.id });
    expect(codeOf(await asOwner.attempt(DeleteStatus, { id: todo?.id }))).toBe(
      "projects.errors.status-not-found",
    );
  });
});

describe("statuses under concurrency and across organisations", () => {
  test("statuses made at once get distinct, gap-free orders", async () => {
    const { asOwner, project } = await withProject(kit);
    await Promise.all(
      ["P", "Q", "R", "S"].map((name) =>
        asOwner.call(CreateStatus, {
          input: {
            projectId: project.id,
            name,
            category: "todo",
            colour: "#112233",
          },
        }),
      ),
    );
    const read = await asOwner.call<{ project: Project }>(ByKey, {
      key: project.key,
    });
    expect(read.project.statuses.map((s) => s.order)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
  });

  test("a member cannot manage statuses or labels, and another organisation's ids match nothing", async () => {
    const { owner, organisation, project } = await withProject(kit);
    const member = await memberWith(
      kit,
      organisation.id,
      owner.token,
      "member",
    );
    const asMember = kit.client(member.token, {
      organisation: organisation.id,
    });
    const statusId = project.statuses[0]?.id;
    for (const [query, variables] of [
      [DeleteStatus, { id: statusId }],
      [Reorder, { projectId: project.id, ids: [] }],
      [DeleteLabel, { id: statusId }],
    ] as const) {
      expect(codeOf(await asMember.attempt(query, variables))).toBe(
        "auth.errors.forbidden",
      );
    }
    const other = await withProject(kit, "OTH");
    expect(
      codeOf(await other.asOwner.attempt(DeleteStatus, { id: statusId })),
    ).toBe("projects.errors.status-not-found");
  });
});

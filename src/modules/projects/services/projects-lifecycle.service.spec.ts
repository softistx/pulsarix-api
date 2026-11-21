import { describe, expect, test } from "bun:test";
import { authApp, memberWith } from "~/auth";
import { codeOf } from "~/http";
import {
  Archive,
  ByKey,
  Create,
  CreateStatus,
  List,
  type Project,
  Unarchive,
  Update,
  withProject,
} from "~/projects";

const kit = authApp();

describe("projects", () => {
  test("a new project has the default workflow, in order", async () => {
    const { project } = await withProject(kit);
    expect(project.key).toBe("ABC");
    expect(project.statuses.map((s) => [s.order, s.name, s.category])).toEqual([
      [0, "Triage", "triage"],
      [1, "Backlog", "backlog"],
      [2, "Todo", "todo"],
      [3, "In progress", "inProgress"],
      [4, "Done", "done"],
      [5, "Cancelled", "cancelled"],
    ]);
    expect(project.labels).toEqual([]);
  });

  test("the key is unique per organisation, whatever its case", async () => {
    const { asOwner } = await withProject(kit, "DUP");
    const again = await asOwner.attempt(Create, {
      input: { key: "dup", name: "Other" },
    });
    expect(codeOf(again)).toBe("projects.errors.key-taken");

    // Another organisation has its own keys.
    const other = await withProject(kit, "DUP");
    expect(other.project.key).toBe("DUP");
  });

  test("a malformed key or an unknown lead is refused as an input", async () => {
    const { asOwner } = await withProject(kit);
    for (const key of ["A", "1AB", "AB-C", "ABCDEFGHIJK"]) {
      const answer = await asOwner.attempt(Create, {
        input: { key, name: "X" },
      });
      expect(codeOf(answer)).toBe("validation.errors.invalid-input");
    }
    const stranger = await withProject(kit, "STR");
    const lead = await asOwner.attempt(Create, {
      input: { key: "LED", name: "X", leadId: stranger.owner.id },
    });
    expect(codeOf(lead)).toBe("validation.errors.invalid-input");
    expect(lead.errors?.[0]?.extensions?.fields?.[0]?.path).toBe("leadId");
  });

  test("a project is read by key, updated, archived and brought back", async () => {
    const { owner, asOwner, project } = await withProject(kit);
    const found = await asOwner.call<{ project: Project }>(ByKey, {
      key: "abc",
    });
    expect(found.project.id).toBe(project.id);
    expect(codeOf(await asOwner.attempt(ByKey, { key: "NOPE" }))).toBe(
      "projects.errors.not-found",
    );

    const updated = await asOwner.call<{
      updateProject: { name: string; leadId: string | null };
    }>(Update, {
      id: project.id,
      input: { name: "Alpha 2", leadId: owner.id },
    });
    expect(updated.updateProject).toEqual({
      id: project.id,
      name: "Alpha 2",
      description: "",
      leadId: owner.id,
    } as never);
    expect(
      codeOf(
        await asOwner.attempt(Update, {
          id: project.id,
          input: { name: null },
        }),
      ),
    ).toBe("validation.errors.invalid-input");

    await asOwner.call(Archive, { id: project.id });
    expect(
      (await asOwner.call<{ projects: unknown[] }>(List)).projects,
    ).toHaveLength(0);
    expect(
      (await asOwner.call<{ projects: unknown[] }>(List, { all: true }))
        .projects,
    ).toHaveLength(1);
    const back = await asOwner.call<{
      unarchiveProject: { archivedAt: string | null };
    }>(Unarchive, { id: project.id });
    expect(back.unarchiveProject.archivedAt).toBeNull();
  });

  test("members read, only admins and owners manage, a stranger sees nothing", async () => {
    const { owner, organisation, project } = await withProject(kit);
    const admin = await memberWith(kit, organisation.id, owner.token, "admin");
    const member = await memberWith(
      kit,
      organisation.id,
      owner.token,
      "member",
    );
    const viewer = await memberWith(
      kit,
      organisation.id,
      owner.token,
      "viewer",
    );
    const as = (token: string) =>
      kit.client(token, { organisation: organisation.id });

    await as(admin.token).call(CreateStatus, {
      input: {
        projectId: project.id,
        name: "Review",
        category: "inProgress",
        colour: "#112233",
      },
    });
    for (const reader of [member, viewer]) {
      const read = await as(reader.token).call<{ projects: unknown[] }>(List);
      expect(read.projects).toHaveLength(1);
      expect(
        codeOf(
          await as(reader.token).attempt(Create, {
            input: { key: "NEW", name: "X" },
          }),
        ),
      ).toBe("auth.errors.forbidden");
      expect(
        codeOf(await as(reader.token).attempt(Archive, { id: project.id })),
      ).toBe("auth.errors.forbidden");
    }

    const outsider = await withProject(kit, "OUT");
    const asOutsider = kit.client(outsider.owner.token, {
      organisation: organisation.id,
    });
    expect(codeOf(await asOutsider.attempt(List))).toBe(
      "tenancy.errors.unknown-organization",
    );
    // Ids of another organisation's project match nothing here.
    expect(
      codeOf(
        await as(owner.token).attempt(Archive, { id: outsider.project.id }),
      ),
    ).toBe("projects.errors.not-found");
  });
});

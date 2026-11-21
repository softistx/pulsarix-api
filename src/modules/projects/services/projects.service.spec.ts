import { describe, expect, test } from "bun:test";
import { authApp, memberWith, ownerWithOrganisation } from "~/auth";
import { codeOf } from "~/http";
import { registerStatusUsage } from "../public";

const kit = authApp();

const projectFields = `id key name description leadId archivedAt
  statuses { id name category order colour } labels { id name colour }`;
const Create = `mutation($input: CreateProjectInput!) {
  createProject(input: $input) { ${projectFields} }
}`;
const Update = `mutation($id: ID!, $input: UpdateProjectInput!) {
  updateProject(id: $id, input: $input) { id name description leadId }
}`;
const Archive = `mutation($id: ID!) { archiveProject(id: $id) { id archivedAt } }`;
const Unarchive = `mutation($id: ID!) { unarchiveProject(id: $id) { id archivedAt } }`;
const List = `query($all: Boolean) { projects(includeArchived: $all) { key } }`;
const ByKey = `query($key: String!) { project(key: $key) { ${projectFields} } }`;
const CreateStatus = `mutation($input: CreateStatusInput!) {
  createStatus(input: $input) { id name order category }
}`;
const UpdateStatus = `mutation($id: ID!, $input: UpdateStatusInput!) {
  updateStatus(id: $id, input: $input) { id name category colour }
}`;
const Reorder = `mutation($projectId: ID!, $ids: [ID!]!) {
  reorderStatuses(projectId: $projectId, ids: $ids) { id name order }
}`;
const DeleteStatus = `mutation($id: ID!) { deleteStatus(id: $id) }`;
const CreateLabel = `mutation($input: CreateLabelInput!) {
  createLabel(input: $input) { id name colour }
}`;
const UpdateLabel = `mutation($id: ID!, $input: UpdateLabelInput!) {
  updateLabel(id: $id, input: $input) { id name colour }
}`;
const DeleteLabel = `mutation($id: ID!) { deleteLabel(id: $id) }`;

interface Project {
  id: string;
  key: string;
  statuses: { id: string; name: string; category: string; order: number }[];
  labels: { id: string; name: string }[];
}

// An organisation with its owner's client, and a project made in it.
async function withProject(key = "ABC") {
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: Project;
  }>(Create, { input: { key, name: "Alpha" } });
  return { owner, organisation, asOwner, project };
}

describe("projects", () => {
  test("a new project has the default workflow, in order", async () => {
    const { project } = await withProject();
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
    const { asOwner } = await withProject("DUP");
    const again = await asOwner.attempt(Create, {
      input: { key: "dup", name: "Other" },
    });
    expect(codeOf(again)).toBe("projects.errors.key-taken");

    // Another organisation has its own keys.
    const other = await withProject("DUP");
    expect(other.project.key).toBe("DUP");
  });

  test("a malformed key or an unknown lead is refused as an input", async () => {
    const { asOwner } = await withProject();
    for (const key of ["A", "1AB", "AB-C", "ABCDEFGHIJK"]) {
      const answer = await asOwner.attempt(Create, {
        input: { key, name: "X" },
      });
      expect(codeOf(answer)).toBe("validation.errors.invalid-input");
    }
    const stranger = await withProject("STR");
    const lead = await asOwner.attempt(Create, {
      input: { key: "LED", name: "X", leadId: stranger.owner.id },
    });
    expect(codeOf(lead)).toBe("validation.errors.invalid-input");
    expect(lead.errors?.[0]?.extensions?.fields?.[0]?.path).toBe("leadId");
  });

  test("a project is read by key, updated, archived and brought back", async () => {
    const { owner, asOwner, project } = await withProject();
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
    const { owner, organisation, project } = await withProject();
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

    const outsider = await withProject("OUT");
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

describe("statuses", () => {
  test("a status is added at the end, renamed and recoloured; names are unique", async () => {
    const { asOwner, project } = await withProject();
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
    const { asOwner, project } = await withProject();
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
    const { asOwner, project } = await withProject();
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
    const { asOwner, project } = await withProject();
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
    const { owner, organisation, project } = await withProject();
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
    const other = await withProject("OTH");
    expect(
      codeOf(await other.asOwner.attempt(DeleteStatus, { id: statusId })),
    ).toBe("projects.errors.status-not-found");
  });
});

describe("labels", () => {
  test("labels are created, renamed, listed by name and deleted; names are unique per project", async () => {
    const { asOwner, project } = await withProject();
    const other = await asOwner.call<{ createProject: Project }>(Create, {
      input: { key: "BET", name: "Beta" },
    });
    const input = { projectId: project.id, name: "bug", colour: "#ff0000" };
    const bug = await asOwner.call<{ createLabel: { id: string } }>(
      CreateLabel,
      { input },
    );
    await asOwner.call(CreateLabel, {
      input: { ...input, name: "Area" },
    });
    expect(codeOf(await asOwner.attempt(CreateLabel, { input }))).toBe(
      "projects.errors.label-name-taken",
    );
    // The same name in another project is fine.
    await asOwner.call(CreateLabel, {
      input: { ...input, projectId: other.createProject.id },
    });
    expect(
      codeOf(
        await asOwner.attempt(CreateLabel, {
          input: { ...input, name: "x", colour: "nope" },
        }),
      ),
    ).toBe("validation.errors.invalid-input");

    const renamed = await asOwner.call<{
      updateLabel: { name: string; colour: string };
    }>(UpdateLabel, {
      id: bug.createLabel.id,
      input: { name: "defect", colour: "#00ff00" },
    });
    expect(renamed.updateLabel).toMatchObject({
      name: "defect",
      colour: "#00ff00",
    });
    const read = await asOwner.call<{ project: Project }>(ByKey, {
      key: project.key,
    });
    expect(read.project.labels.map((l) => l.name)).toEqual(["Area", "defect"]);

    await asOwner.call(DeleteLabel, { id: bug.createLabel.id });
    expect(
      codeOf(await asOwner.attempt(DeleteLabel, { id: bug.createLabel.id })),
    ).toBe("projects.errors.label-not-found");
  });
});

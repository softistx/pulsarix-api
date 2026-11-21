import { describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { codeOf } from "~/http";
import {
  ByKey,
  Create,
  CreateLabel,
  DeleteLabel,
  type Project,
  UpdateLabel,
  withProject,
} from "~/projects";

const kit = authApp();

describe("labels", () => {
  test("labels are created, renamed, listed by name and deleted; names are unique per project", async () => {
    const { asOwner, project } = await withProject(kit);
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

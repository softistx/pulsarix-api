import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { CreateProject } from "~/issues";
import {
  CreateSprint,
  DeleteSprint,
  UpdateProject,
  UpdateSprint,
  withSprints,
} from "~/sprints";

describe("managing sprints", () => {
  test("a project has sprints off until its settings turn them on", async () => {
    const { asOwner, project } = await (await import("~/issues")).withProject(
      "OFF",
    );
    const refused = await asOwner.attempt(CreateSprint, {
      projectId: project.id,
      input: {},
    });
    expect(codeOf(refused)).toBe("sprints.errors.disabled");
    const on = await asOwner.call<{
      updateProject: { sprintsEnabled: boolean; sprintLengthWeeks: number };
    }>(UpdateProject, { id: project.id, input: { sprintsEnabled: true } });
    expect(on.updateProject).toEqual({
      id: project.id,
      sprintsEnabled: true,
      sprintLengthWeeks: 2,
    } as never);
  });

  test("the sprint length is 1 to 4 weeks", async () => {
    const t = await withSprints("LEN");
    const ok = await t.asOwner.call<{
      updateProject: { sprintLengthWeeks: number };
    }>(UpdateProject, { id: t.project.id, input: { sprintLengthWeeks: 4 } });
    expect(ok.updateProject.sprintLengthWeeks).toBe(4);
    for (const weeks of [0, 5]) {
      const refused = await t.asOwner.attempt(UpdateProject, {
        id: t.project.id,
        input: { sprintLengthWeeks: weeks },
      });
      expect(codeOf(refused)).toBe("validation.errors.invalid-input");
    }
  });

  test("sprints are numbered in order and named until the team names them", async () => {
    const t = await withSprints("NUM");
    const first = await t.sprint();
    const second = await t.sprint({ name: "Hardening", goal: "Fix it" });
    expect([first.number, first.name, first.state]).toEqual([
      1,
      "Sprint 1",
      "planned",
    ]);
    expect([second.number, second.name, second.goal]).toEqual([
      2,
      "Hardening",
      "Fix it",
    ]);
    expect((await t.all()).map((s) => s.number)).toEqual([1, 2]);
  });

  test("a sprint's end cannot be before its start", async () => {
    const t = await withSprints("DAT");
    const refused = await t.asOwner.attempt(CreateSprint, {
      projectId: t.project.id,
      input: {
        startDate: "2026-03-10T00:00:00Z",
        endDate: "2026-03-01T00:00:00Z",
      },
    });
    expect(codeOf(refused)).toBe("validation.errors.invalid-input");
    const sprint = await t.sprint();
    const bad = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: {
        startDate: "2026-03-10T00:00:00Z",
        endDate: "2026-03-01T00:00:00Z",
      },
    });
    expect(codeOf(bad)).toBe("validation.errors.invalid-input");
  });

  test("a planned or active sprint is renamed, a closed one is not", async () => {
    const t = await withSprints("UPD");
    const sprint = await t.sprint();
    const renamed = await t.asOwner.call<{
      updateSprint: { name: string; goal: string | null };
    }>(UpdateSprint, { id: sprint.id, input: { name: "Alpha", goal: "Ship" } });
    expect(renamed.updateSprint).toMatchObject({
      name: "Alpha",
      goal: "Ship",
    });
    const cleared = await t.asOwner.call<{
      updateSprint: { goal: string | null };
    }>(UpdateSprint, { id: sprint.id, input: { goal: null } });
    expect(cleared.updateSprint.goal).toBeNull();
    const noName = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: null },
    });
    expect(codeOf(noName)).toBe("validation.errors.invalid-input");
    await t.start(sprint.id);
    await t.close(sprint.id, { unfinished: "BACKLOG" });
    const closed = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: "Late" },
    });
    expect(codeOf(closed)).toBe("sprints.errors.closed");
  });

  test("a planned sprint is deleted and its issues go back to the backlog", async () => {
    const t = await withSprints("DEL");
    const sprint = await t.sprint();
    const issue = await t.make("Planned");
    await t.plan([issue], sprint.id);
    const gone = await t.asOwner.call<{ deleteSprint: string }>(DeleteSprint, {
      id: sprint.id,
    });
    expect(gone.deleteSprint).toBe(sprint.id);
    expect(await t.all()).toEqual([]);
    expect(await t.titles({ sprintId: sprint.id })).toEqual([]);
    expect(await t.titles({ backlog: true })).toContain("Planned");
    const again = await t.asOwner.attempt(DeleteSprint, { id: sprint.id });
    expect(codeOf(again)).toBe("sprints.errors.not-found");
  });

  test("an active sprint is not deleted", async () => {
    const t = await withSprints("DAC");
    const sprint = await t.sprint();
    await t.start(sprint.id);
    const refused = await t.asOwner.attempt(DeleteSprint, { id: sprint.id });
    expect(codeOf(refused)).toBe("sprints.errors.not-planned");
  });

  test("sprints cannot be turned off while one is active", async () => {
    const t = await withSprints("TOF");
    const sprint = await t.sprint();
    await t.start(sprint.id);
    const refused = await t.asOwner.attempt(UpdateProject, {
      id: t.project.id,
      input: { sprintsEnabled: false },
    });
    expect(codeOf(refused)).toBe("sprints.errors.active-sprint");
    await t.close(sprint.id);
    const off = await t.asOwner.call<{
      updateProject: { sprintsEnabled: boolean };
    }>(UpdateProject, { id: t.project.id, input: { sprintsEnabled: false } });
    expect(off.updateProject.sprintsEnabled).toBe(false);
  });

  test("the list filters by state and a project without sprints lists none", async () => {
    const t = await withSprints("LST");
    const a = await t.sprint();
    await t.sprint();
    await t.start(a.id);
    expect((await t.all(["active"])).map((s) => s.number)).toEqual([1]);
    expect((await t.all(["planned", "closed"])).map((s) => s.number)).toEqual([
      2,
    ]);
    const other = await t.asOwner.call<{ createProject: { id: string } }>(
      CreateProject,
      { input: { key: "NONE", name: "None" } },
    );
    const none = await t.asOwner.call<{ sprints: unknown[] }>(
      (await import("~/sprints")).Sprints,
      { projectId: other.createProject.id },
    );
    expect(none.sprints).toEqual([]);
  });
});

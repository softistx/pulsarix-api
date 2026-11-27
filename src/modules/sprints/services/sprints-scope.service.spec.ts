import { describe, expect, test } from "bun:test";
import { codeOf } from "~/http";
import { Create, CreateProject, type Issue, Move, Update } from "~/issues";
import {
  CloseSprint,
  CreateSprint,
  DeleteSprint,
  PlanIssues,
  type Sprint,
  StartSprint,
  UpdateProject,
  UpdateSprint,
  withSprints,
} from "~/sprints";

// Two projects of one organisation: the caller works in `t`, `other` is the
// sibling whose ids it must not reach.
async function twoProjects() {
  const t = await withSprints("SCA");
  const { createProject: other } = await t.asOwner.call<{
    createProject: { id: string };
  }>(CreateProject, { input: { key: "SCB", name: "Beta" } });
  await t.asOwner.call(UpdateProject, {
    id: other.id,
    input: { sprintsEnabled: true },
  });
  const foreignSprint = (
    await t.asOwner.call<{ createSprint: Sprint }>(CreateSprint, {
      projectId: other.id,
      input: {},
    })
  ).createSprint;
  const foreignIssue = (
    await t.asOwner.call<{ createIssue: Issue }>(Create, {
      input: { projectId: other.id, title: "Foreign", type: "task" },
    })
  ).createIssue;
  return { t, other: other.id, foreignSprint, foreignIssue };
}

describe("the project of a sprint mutation", () => {
  test("updateSprint, deleteSprint and startSprint refuse a sprint of another project", async () => {
    const { t, other } = await twoProjects();
    const sprint = await t.sprint();
    const update = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: "X" },
      projectId: other,
    });
    expect(codeOf(update)).toBe("sprints.errors.wrong-project");
    const del = await t.asOwner.attempt(DeleteSprint, {
      id: sprint.id,
      projectId: other,
    });
    expect(codeOf(del)).toBe("sprints.errors.wrong-project");
    const start = await t.asOwner.attempt(StartSprint, {
      id: sprint.id,
      input: { startDate: "2026-03-02T00:00:00Z" },
      projectId: other,
    });
    expect(codeOf(start)).toBe("sprints.errors.wrong-project");
    expect((await t.all()).map((s) => [s.id, s.state, s.name])).toEqual([
      [sprint.id, "planned", sprint.name],
    ]);
  });

  test("the own project passes, and so does no project at all", async () => {
    const { t } = await twoProjects();
    const sprint = await t.sprint();
    const named = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: "Mine" },
      projectId: t.project.id,
    });
    expect(codeOf(named)).toBeUndefined();
    const bare = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: "Bare" },
    });
    expect(codeOf(bare)).toBeUndefined();
  });

  test("closeSprint refuses another project, and a next sprint of another project", async () => {
    const { t, other, foreignSprint } = await twoProjects();
    const sprint = await t.sprint();
    await t.start(sprint.id);
    const close = await t.asOwner.attempt(CloseSprint, {
      id: sprint.id,
      input: { unfinished: "BACKLOG" },
      projectId: other,
    });
    expect(codeOf(close)).toBe("sprints.errors.wrong-project");
    await t
      .make("Open", { type: "task" })
      .then((issue) => t.plan([issue], sprint.id));
    const next = await t.asOwner.attempt(CloseSprint, {
      id: sprint.id,
      input: { unfinished: "NEXT_SPRINT", nextSprintId: foreignSprint.id },
    });
    expect(codeOf(next)).toBe("sprints.errors.wrong-project");
    expect((await t.all(["active"])).length).toBe(1);
  });

  test("planIssues refuses issues of another project, and a sprint of another project", async () => {
    const { t, other, foreignSprint } = await twoProjects();
    const sprint = await t.sprint();
    const issue = await t.make("A", { type: "task" });
    const wrongIssues = await t.asOwner.attempt(PlanIssues, {
      ids: [issue.id],
      sprintId: sprint.id,
      projectId: other,
    });
    expect(codeOf(wrongIssues)).toBe("sprints.errors.wrong-project");
    const wrongSprint = await t.asOwner.attempt(PlanIssues, {
      ids: [issue.id],
      sprintId: foreignSprint.id,
      projectId: t.project.id,
    });
    expect(codeOf(wrongSprint)).toBe("sprints.errors.wrong-project");
    expect(await t.titles({ sprintId: sprint.id })).toEqual([]);
  });

  test("planIssues refuses a rank anchor of another project", async () => {
    const { t, foreignIssue: anchor } = await twoProjects();
    const sprint = await t.sprint();
    const issue = await t.make("A", { type: "task" });
    const refused = await t.asOwner.attempt(PlanIssues, {
      ids: [issue.id],
      sprintId: sprint.id,
      afterId: anchor.id,
      projectId: t.project.id,
    });
    expect(codeOf(refused)).toBe("issues.errors.bad-placement");
  });

  test("updateIssue (assign, estimate) and moveIssue refuse an issue of another project", async () => {
    const { t, other, foreignIssue } = await twoProjects();
    const issue = await t.make("A", { type: "task" });
    for (const input of [{ points: 5 }, { assigneeId: null }]) {
      const refused = await t.asOwner.attempt(Update, {
        id: issue.id,
        input,
        projectId: other,
      });
      expect(codeOf(refused)).toBe("issues.errors.wrong-project");
    }
    const moved = await t.asOwner.attempt(Move, {
      id: issue.id,
      statusId: t.todo,
      projectId: other,
    });
    expect(codeOf(moved)).toBe("issues.errors.wrong-project");
    const mine = await t.asOwner.attempt(Update, {
      id: issue.id,
      input: { points: 5 },
      projectId: t.project.id,
    });
    expect(codeOf(mine)).toBeUndefined();
    const foreign = await t.asOwner.attempt(Update, {
      id: foreignIssue.id,
      input: { points: 3 },
      projectId: t.project.id,
    });
    expect(codeOf(foreign)).toBe("issues.errors.wrong-project");
  });

  test("an empty projectId is invalid input, not a skipped check", async () => {
    const { t } = await twoProjects();
    const sprint = await t.sprint();
    const issue = await t.make("A", { type: "task" });
    const sprints = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: "X" },
      projectId: "",
    });
    expect(codeOf(sprints)).toBe("validation.errors.invalid-input");
    const issues = await t.asOwner.attempt(Update, {
      id: issue.id,
      input: { points: 5 },
      projectId: "",
    });
    expect(codeOf(issues)).toBe("validation.errors.invalid-input");
  });

  test("an id of another organisation is not found, not a wrong project", async () => {
    const { t } = await twoProjects();
    const away = await withSprints("SCZ");
    const sprint = await away.sprint();
    const issue = await away.make("Away", { type: "task" });
    const gone = await t.asOwner.attempt(UpdateSprint, {
      id: sprint.id,
      input: { name: "X" },
      projectId: t.project.id,
    });
    expect(codeOf(gone)).toBe("sprints.errors.not-found");
    const missing = await t.asOwner.attempt(Update, {
      id: issue.id,
      input: { points: 5 },
      projectId: t.project.id,
    });
    expect(codeOf(missing)).toBe("issues.errors.not-found");
  });

  test("moveIssue refuses a status or a rank anchor of another project", async () => {
    const { t, other, foreignIssue } = await twoProjects();
    const issue = await t.make("A", { type: "task" });
    const { createProject: sibling } = await t.asOwner.call<{
      createProject: { statuses: { id: string }[] };
    }>(CreateProject, { input: { key: "SCF", name: "Gamma" } });
    const status = await t.asOwner.attempt(Move, {
      id: issue.id,
      statusId: sibling.statuses[1]?.id,
      projectId: t.project.id,
    });
    expect(status.errors).toBeDefined();
    const anchor = await t.asOwner.attempt(Move, {
      id: issue.id,
      statusId: t.todo,
      afterId: foreignIssue.id,
      projectId: t.project.id,
    });
    expect(codeOf(anchor)).toBe("issues.errors.bad-placement");
    expect(other).toBeDefined();
  });
});

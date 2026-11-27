import type { ObjectId } from "mongodb";
import { changesBetween } from "../../../core/shared/changes";
import { invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { IssuePlanning } from "../../issues/public";
import {
  activeExists,
  sprintNotActive,
  sprintNotFound,
  sprintNotPlanned,
} from "../sprints.errors";
import type { SprintDocument } from "../sprints.model";
import { datesIssues } from "../sprints.rules";
import {
  defaultEnd,
  defaultName,
  isFinished,
  pointsOf,
} from "../sprints.utils";
import type { SprintsProject, SprintWork } from "./sprints-project.service";

export interface StartInput {
  name?: string | null | undefined;
  goal?: string | null | undefined;
  startDate: Date;
  endDate?: Date | null | undefined;
}

export interface CloseInput {
  unfinished: "NEXT_SPRINT" | "BACKLOG";
  nextSprintId?: string | null | undefined;
}

// The two moments of a sprint's life: it starts (its scope is snapshotted) and
// it closes (its done points are counted, its unfinished issues move on).
export class SprintLifecycle {
  constructor(private readonly project: SprintsProject) {}

  async start(id: string, input: StartInput): Promise<SprintDocument> {
    const current = await this.project.byId(id);
    return this.project.inProject(
      current.projectId,
      async ({ tx, project, changed }) => {
        const sprint = await tx.db.sprints.findById(current._id);
        if (!sprint) throw sprintNotFound();
        if (sprint.state !== "planned") throw sprintNotPlanned();
        const running = await tx.db.sprints.exists({
          projectId: sprint.projectId,
          state: "active",
        });
        if (running) throw activeExists();
        const endDate =
          input.endDate ??
          defaultEnd(input.startDate, project.sprintLengthWeeks ?? 2);
        const issues = datesIssues(input.startDate, endDate);
        if (issues.length > 0) throw invalid(issues);
        const scope = await tx.db.issues.findMany({
          filter: { sprintId: sprint._id },
        });
        const updated = await tx.db.sprints.update(sprint._id, {
          state: "active",
          name: input.name ?? sprint.name,
          goal: input.goal === undefined ? sprint.goal : input.goal,
          startDate: input.startDate,
          endDate,
          committedPoints: pointsOf(scope),
        });
        await changed(
          "started",
          updated,
          changesBetween(sprint, updated, [
            "state",
            "name",
            "goal",
            "startDate",
            "endDate",
            "committedPoints",
          ]),
        );
        return updated;
      },
      { enabled: true },
    );
  }

  async close(id: string, input: CloseInput): Promise<SprintDocument> {
    const current = await this.project.byId(id);
    return this.project.inProject(current.projectId, async (run) => {
      const { tx, changed, after } = run;
      const sprint = await tx.db.sprints.findById(current._id);
      if (!sprint) throw sprintNotFound();
      if (sprint.state !== "active") throw sprintNotActive();
      const statuses = await tx.db.statuses.findMany({
        filter: { projectId: sprint.projectId },
      });
      const category = new Map(
        statuses.map((s) => [s._id.toHexString(), s.category]),
      );
      const all = await tx.db.issues.findMany({
        filter: { sprintId: sprint._id },
        sort: { planRank: 1 },
      });
      const stateOf = (issue: (typeof all)[number]) =>
        category.get(issue.statusId.toHexString()) ?? "backlog";
      const unfinished = all.filter((issue) => !isFinished(stateOf(issue)));
      const done = all.filter((issue) => stateOf(issue) === "done");
      if (unfinished.length > 0) {
        const target =
          input.unfinished === "BACKLOG"
            ? null
            : await this.nextSprint(run, sprint, input.nextSprintId);
        const planning = new IssuePlanning(
          this.project.viewerId,
          this.project.organisationId,
        );
        after((await planning.place(tx, unfinished, target)).later);
      }
      const updated = await tx.db.sprints.update(sprint._id, {
        state: "closed",
        closedAt: new Date(),
        completedPoints: pointsOf(done),
      });
      await changed(
        "closed",
        updated,
        changesBetween(sprint, updated, ["state", "completedPoints"]),
      );
      return updated;
    });
  }

  // The planned sprint that takes the unfinished issues: the one named, or the
  // next planned one by number, made when the project has none.
  private async nextSprint(
    { tx, changed }: SprintWork,
    sprint: SprintDocument,
    named: string | null | undefined,
  ): Promise<ObjectId> {
    if (named) {
      const found = await tx.db.sprints.findById(
        idOrInvalid(named, "nextSprintId"),
      );
      if (!found?.projectId.equals(sprint.projectId)) throw sprintNotFound();
      if (found.state !== "planned") throw sprintNotPlanned();
      return found._id;
    }
    const [planned] = await tx.db.sprints.findMany({
      filter: { projectId: sprint.projectId, state: "planned" },
      sort: { number: 1 },
      limit: 1,
    });
    if (planned) return planned._id;
    const number =
      ((
        await tx.db.sprints.findMany({
          filter: { projectId: sprint.projectId },
          sort: { number: -1 },
          limit: 1,
        })
      )[0]?.number ?? 0) + 1;
    const made = await tx.db.sprints.create({
      projectId: sprint.projectId,
      number,
      name: defaultName(number),
      goal: null,
      state: "planned",
    });
    await changed("created", made, []);
    return made._id;
  }
}

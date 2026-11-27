import type { ObjectId } from "mongodb";
import { changesBetween } from "../../../core/shared/changes";
import { dayIn, earlierDay } from "../../../core/shared/days";
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
import { SprintSnapshots } from "./snapshots.service";
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

const STARTED = [
  "state",
  "name",
  "goal",
  "startDate",
  "endDate",
  "committedPoints",
] as const;

// The two moments of a sprint's life: it starts (its scope is snapshotted) and
// it closes (its done points are counted, its unfinished issues move on).
export class SprintLifecycle {
  constructor(private readonly project: SprintsProject) {}

  async start(id: string, input: StartInput): Promise<SprintDocument> {
    const current = await this.project.byId(id);
    return this.project.inProject(
      current.projectId,
      async ({ tx, project, changed }) => {
        const sprint = await this.plannedOf(tx, current._id);
        const endDate =
          input.endDate ??
          defaultEnd(
            input.startDate,
            project.sprintLengthWeeks ?? 2,
            this.project.timeZone,
          );
        const issues = datesIssues(input.startDate, endDate);
        if (issues.length > 0) throw invalid(issues);
        const snapshots = new SprintSnapshots(tx, this.project.timeZone);
        const updated = await tx.db.sprints.update(sprint._id, {
          state: "active",
          name: input.name ?? sprint.name,
          goal: input.goal === undefined ? sprint.goal : input.goal,
          startDate: input.startDate,
          endDate,
          // The scope without the cancelled issues, as the burndown counts it.
          committedPoints: (await snapshots.measure(sprint)).scopePoints,
        });
        await this.snapshotStart(snapshots, updated, input.startDate);
        await changed(
          "started",
          updated,
          changesBetween(sprint, updated, STARTED),
        );
        return updated;
      },
      { enabled: true },
    );
  }

  // The sprint, still planned, with no other active in its project.
  private async plannedOf(
    tx: SprintWork["tx"],
    id: ObjectId,
  ): Promise<SprintDocument> {
    const sprint = await tx.db.sprints.findById(id);
    if (!sprint) throw sprintNotFound();
    if (sprint.state !== "planned") throw sprintNotPlanned();
    const running = await tx.db.sprints.exists({
      projectId: sprint.projectId,
      state: "active",
    });
    if (running) throw activeExists();
    return sprint;
  }

  // The burndown starts from the committed scope, counted to the start's day
  // (the day it is taken when the start is still to come).
  private async snapshotStart(
    snapshots: SprintSnapshots,
    sprint: SprintDocument,
    startDate: Date,
  ): Promise<void> {
    const now = new Date();
    const today = dayIn(this.project.timeZone, now);
    const startDay = dayIn(this.project.timeZone, startDate);
    await snapshots.take(sprint, "start", now, earlierDay(startDay, today));
  }

  async close(id: string, input: CloseInput): Promise<SprintDocument> {
    const current = await this.project.byId(id);
    return this.project.inProject(current.projectId, async (run) => {
      const { tx, changed } = run;
      const sprint = await tx.db.sprints.findById(current._id);
      if (!sprint) throw sprintNotFound();
      if (sprint.state !== "active") throw sprintNotActive();
      await new SprintSnapshots(tx, this.project.timeZone).take(
        sprint,
        "close",
        new Date(),
      );
      const completedPoints = await this.moveUnfinished(run, sprint, input);
      const updated = await tx.db.sprints.update(sprint._id, {
        state: "closed",
        closedAt: new Date(),
        completedPoints,
      });
      await changed(
        "closed",
        updated,
        changesBetween(sprint, updated, ["state", "completedPoints"]),
      );
      return updated;
    });
  }

  // Sends the issues that are not done or cancelled to the next sprint or the
  // backlog; returns the points of the done ones.
  private async moveUnfinished(
    run: SprintWork,
    sprint: SprintDocument,
    input: CloseInput,
  ): Promise<number> {
    const { tx, after } = run;
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
    return pointsOf(all.filter((issue) => stateOf(issue) === "done"));
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

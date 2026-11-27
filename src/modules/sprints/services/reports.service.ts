import {
  addDays,
  dayIn,
  daysBetween,
  laterDay,
} from "../../../core/shared/days";
import { idOrInvalid } from "../../../core/shared/ids";
import { projectNotFound } from "../../projects/public";
import type { SprintBurndown, Velocity } from "../sprints.types";
import { averageOf, idealRemaining, latestUpTo } from "../sprints.utils";
import { SprintSnapshots } from "./snapshots.service";
import type { SprintsProject } from "./sprints-project.service";

// What a sprint's history says (plan §28): its burndown from the snapshots
// and the project's velocity over its closed sprints. Reads only.
export class SprintReports {
  constructor(private readonly project: SprintsProject) {}

  // Day by day, from the start's day to the end's (or later while it overruns):
  // the ideal line, and the points still to do as the day's last snapshot says,
  // today's from the issues as they stand. Days are the organisation's.
  async burndown(id: string, now: Date): Promise<SprintBurndown> {
    const { mongo, timeZone } = this.project;
    const sprint = await this.project.byId(id);
    const base = {
      sprintId: sprint._id.toHexString(),
      committedPoints: sprint.committedPoints,
      timeZone,
    };
    if (sprint.state === "planned" || !sprint.startDate || !sprint.endDate) {
      return { ...base, points: [] };
    }
    const first = dayIn(timeZone, sprint.startDate);
    const planned = dayIn(timeZone, sprint.endDate);
    const today = dayIn(timeZone, now);
    const observed =
      sprint.state === "closed" && sprint.closedAt
        ? dayIn(timeZone, sprint.closedAt)
        : today;
    const last = laterDay(planned, observed);
    const length = daysBetween(first, planned);
    const snapshots = await mongo.db.sprintSnapshots.findMany({
      filter: { sprintId: sprint._id },
    });
    const live =
      sprint.state === "active"
        ? await new SprintSnapshots(mongo, timeZone).measure(sprint)
        : null;
    const points = [];
    for (let day = first, index = 0; day <= last; day = addDays(day, 1)) {
      const ideal = idealRemaining(sprint.committedPoints, index, length);
      index += 1;
      const figures =
        day > observed
          ? null
          : day === today && live
            ? live
            : latestUpTo(snapshots, day);
      points.push({
        day,
        ideal,
        remainingPoints: figures
          ? figures.scopePoints - figures.completedPoints
          : null,
        scopePoints: figures?.scopePoints ?? null,
        completedPoints: figures?.completedPoints ?? null,
      });
    }
    return { ...base, points };
  }

  // The last `last` closed sprints of the project, oldest first, and the mean
  // of their completed points.
  async velocity(projectId: string, last: number): Promise<Velocity> {
    const id = idOrInvalid(projectId, "projectId");
    const { mongo } = this.project;
    if (!(await mongo.db.projects.exists({ _id: id }))) {
      throw projectNotFound();
    }
    const closed = await mongo.db.sprints.findMany({
      filter: { projectId: id, state: "closed" },
      sort: { number: -1 },
      limit: last,
    });
    const sprints = closed.reverse().map((sprint) => ({
      sprintId: sprint._id.toHexString(),
      number: sprint.number,
      name: sprint.name,
      committedPoints: sprint.committedPoints,
      completedPoints: sprint.completedPoints,
      closedAt: sprint.closedAt,
    }));
    return {
      sprints,
      average: averageOf(sprints.map((sprint) => sprint.completedPoints)),
    };
  }
}

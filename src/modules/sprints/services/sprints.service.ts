import { changesBetween } from "../../../core/shared/changes";
import { invalid, required } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { IssuePlanning } from "../../issues/public";
import { projectNotFound } from "../../projects/public";
import {
  sprintClosed,
  sprintNotFound,
  sprintNotPlanned,
} from "../sprints.errors";
import type { SprintDocument, SprintState } from "../sprints.model";
import { datesIssues } from "../sprints.rules";
import { defaultName } from "../sprints.utils";
import type { SprintsProject } from "./sprints-project.service";

const FIELDS = ["name", "goal", "startDate", "endDate"] as const;

export interface SprintInput {
  name?: string | null | undefined;
  goal?: string | null | undefined;
  startDate?: Date | null | undefined;
  endDate?: Date | null | undefined;
}

// Making, changing, deleting and listing the sprints of a project. Starting
// and closing are `SprintLifecycle`'s, planning issues `SprintPlanning`'s.
export class SprintsService {
  constructor(private readonly project: SprintsProject) {}

  async list(
    projectId: string,
    states?: readonly SprintState[] | null,
  ): Promise<SprintDocument[]> {
    const id = idOrInvalid(projectId, "projectId");
    if (!(await this.project.mongo.db.projects.exists({ _id: id }))) {
      throw projectNotFound();
    }
    return this.project.mongo.db.sprints.findMany({
      filter: {
        projectId: id,
        ...(states && states.length > 0 && { state: { $in: [...states] } }),
      },
      sort: { number: 1 },
    });
  }

  async create(projectId: string, input: SprintInput): Promise<SprintDocument> {
    const id = idOrInvalid(projectId, "projectId");
    const issues = datesIssues(input.startDate ?? null, input.endDate ?? null);
    if (issues.length > 0) throw invalid(issues);
    return this.project.inProject(
      id,
      async ({ tx, changed }) => {
        const [last] = await tx.db.sprints.findMany({
          filter: { projectId: id },
          sort: { number: -1 },
          limit: 1,
        });
        const number = (last?.number ?? 0) + 1;
        const sprint = await tx.db.sprints.create({
          projectId: id,
          number,
          name: input.name ?? defaultName(number),
          goal: input.goal ?? null,
          state: "planned",
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
        });
        await changed("created", sprint, []);
        return sprint;
      },
      { enabled: true },
    );
  }

  async update(id: string, input: SprintInput): Promise<SprintDocument> {
    const current = await this.project.byId(id);
    const missing = required(input, ["name"]);
    if (missing.length > 0) throw invalid(missing);
    return this.project.inProject(
      current.projectId,
      async ({ tx, changed }) => {
        const sprint = await tx.db.sprints.findById(current._id);
        if (!sprint) throw sprintNotFound();
        if (sprint.state === "closed") throw sprintClosed();
        const patch = {
          ...(typeof input.name === "string" && { name: input.name }),
          ...(input.goal !== undefined && { goal: input.goal }),
          ...(input.startDate !== undefined && { startDate: input.startDate }),
          ...(input.endDate !== undefined && { endDate: input.endDate }),
        };
        const next = { ...sprint, ...patch };
        const issues = datesIssues(next.startDate, next.endDate);
        if (issues.length > 0) throw invalid(issues);
        const updated = await tx.db.sprints.update(sprint._id, patch);
        const changes = changesBetween(sprint, updated, FIELDS);
        if (changes.length > 0) await changed("updated", updated, changes);
        return updated;
      },
    );
  }

  // A planned sprint only; its issues go back to the end of the backlog.
  async delete(id: string): Promise<string> {
    const current = await this.project.byId(id);
    await this.project.inProject(
      current.projectId,
      async ({ tx, changed, after }) => {
        const sprint = await tx.db.sprints.findById(current._id);
        if (!sprint) throw sprintNotFound();
        if (sprint.state !== "planned") throw sprintNotPlanned();
        const issues = await tx.db.issues.findMany({
          filter: { sprintId: sprint._id },
          sort: { planRank: 1 },
        });
        const planning = new IssuePlanning(
          this.project.viewerId,
          this.project.organisationId,
        );
        const moved = await planning.place(tx, issues, null);
        after(moved.later);
        await tx.db.sprints.hardDelete(sprint._id);
        await changed("deleted", sprint, []);
      },
    );
    return current.id;
  }
}

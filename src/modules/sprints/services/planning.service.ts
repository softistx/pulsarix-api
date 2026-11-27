import type { ObjectId } from "mongodb";
import { invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import {
  type IssueDocument,
  IssuePlanning,
  issueNotFound,
} from "../../issues/public";
import {
  sprintClosed,
  sprintNotFound,
  typeNotAllowed,
  wrongProject,
} from "../sprints.errors";
import { plannable } from "../sprints.utils";
import { SprintSnapshots } from "./snapshots.service";
import type { SprintsProject, SprintWork } from "./sprints-project.service";

export interface PlanInput {
  ids: readonly string[];
  sprintId?: string | null | undefined;
  afterId?: string | null | undefined;
  beforeId?: string | null | undefined;
  projectId?: string | null | undefined;
}

// Puts issues in a sprint or back in the backlog, at a place among its issues.
export class SprintPlanning {
  constructor(private readonly project: SprintsProject) {}

  async plan(input: PlanInput): Promise<IssueDocument[]> {
    const ids = [...new Set(input.ids)].map((id) => idOrInvalid(id, "ids"));
    if (ids.length === 0) {
      throw invalid([{ path: "ids", code: "validation.errors.required" }]);
    }
    const found = await this.project.mongo.db.issues.findMany({
      filter: { _id: { $in: ids } },
    });
    const first = found[0];
    if (!first || found.length !== ids.length) throw issueNotFound();
    if (found.some((issue) => !issue.projectId.equals(first.projectId))) {
      throw invalid([{ path: "ids", code: "validation.errors.invalid" }]);
    }
    this.project.inScope(first.projectId, input.projectId);
    const sprintId = input.sprintId
      ? idOrInvalid(input.sprintId, "sprintId")
      : null;
    const after = input.afterId ? idOrInvalid(input.afterId, "afterId") : null;
    const before = input.beforeId
      ? idOrInvalid(input.beforeId, "beforeId")
      : null;
    return this.project.inProject(
      first.projectId,
      async ({ tx, after: later }) => {
        const ordered = await this.ordered(tx, ids);
        if (!plannable(ordered)) throw typeNotAllowed();
        await this.checkSprints(tx, first.projectId, ordered, sprintId);
        const planning = new IssuePlanning(
          this.project.viewerId,
          this.project.organisationId,
        );
        const result = await planning.place(tx, ordered, sprintId, {
          afterId: after,
          beforeId: before,
        });
        later(result.later);
        await this.snapshotScope(tx, ordered, sprintId);
        return result.issues;
      },
      { enabled: true },
    );
  }

  // A scope change of the active sprint, the one the issues joined or left,
  // is a snapshot of the burndown.
  private async snapshotScope(
    tx: SprintWork["tx"],
    before: IssueDocument[],
    sprintId: ObjectId | null,
  ) {
    const ids = new Map<string, ObjectId>();
    for (const id of [sprintId, ...before.map((issue) => issue.sprintId)]) {
      if (id) ids.set(id.toHexString(), id);
    }
    if (ids.size === 0) return;
    const active = await tx.db.sprints.findMany({
      filter: { _id: { $in: [...ids.values()] }, state: "active" },
    });
    const snapshots = new SprintSnapshots(tx, this.project.timeZone);
    const now = new Date();
    for (const sprint of active) await snapshots.take(sprint, "scope", now);
  }

  // The issues as the transaction sees them, in the order of `ids`.
  private async ordered(
    tx: SprintWork["tx"],
    ids: ObjectId[],
  ): Promise<IssueDocument[]> {
    const issues = await tx.db.issues.findMany({
      filter: { _id: { $in: ids } },
    });
    const byId = new Map(
      issues.map((issue) => [issue._id.toHexString(), issue]),
    );
    return ids.map((id) => {
      const issue = byId.get(id.toHexString());
      if (!issue) throw issueNotFound();
      return issue;
    });
  }

  // The target sprint is the project's and not closed, and no issue leaves a
  // closed sprint (its done work stays with it).
  private async checkSprints(
    tx: SprintWork["tx"],
    projectId: ObjectId,
    issues: IssueDocument[],
    sprintId: ObjectId | null,
  ) {
    if (sprintId) {
      const target = await tx.db.sprints.findById(sprintId);
      if (!target) throw sprintNotFound();
      if (!target.projectId.equals(projectId)) throw wrongProject();
      if (target.state === "closed") throw sprintClosed();
    }
    const current = issues.flatMap((issue) =>
      issue.sprintId ? [issue.sprintId] : [],
    );
    if (
      current.length > 0 &&
      (await tx.db.sprints.exists({ _id: { $in: current }, state: "closed" }))
    ) {
      throw sprintClosed();
    }
  }
}

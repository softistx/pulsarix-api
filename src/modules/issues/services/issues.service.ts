import type { AnyDb } from "../../../config/db";
import { changesBetween } from "../../../core/shared/changes";
import { issueNotFound } from "../issues.errors";
import type { IssueDocument } from "../issues.model";
import type {
  BulkUpdateIssueInput,
  BulkUpdateResult,
  CreateIssueInput,
  IsMember,
  IssuesMongo,
  UpdateIssueInput,
} from "../issues.types";
import { issueRemoved } from "../issues.usage";
import { orphanPatch } from "../utils/orphan.utils";
import { IssueCreation } from "./create.service";
import { IssuesProject } from "./issues-project.service";
import { IssueMoves } from "./move.service";
import { IssueUpdates } from "./update.service";

// The issues of an organisation: reads, deletion and watching here, the
// creation, the edits and the moves in their own services.
export class IssuesService {
  private readonly project: IssuesProject;
  private readonly creation: IssueCreation;
  private readonly moves: IssueMoves;
  private readonly updates: IssueUpdates;

  constructor(
    mongo: IssuesMongo,
    isMember: IsMember,
    private readonly viewerId: string,
    organisationId: string,
    timeZone: string,
  ) {
    this.project = new IssuesProject(
      mongo,
      isMember,
      viewerId,
      organisationId,
      timeZone,
    );
    this.creation = new IssueCreation(this.project);
    this.moves = new IssueMoves(this.project);
    this.updates = new IssueUpdates(this.project, this.moves);
  }

  byKey(key: string): Promise<IssueDocument> {
    return this.project.byKey(key);
  }

  byId(id: string): Promise<IssueDocument> {
    return this.project.byId(id);
  }

  create(input: CreateIssueInput): Promise<IssueDocument> {
    return this.creation.create(input);
  }

  // Several issues of one project, all or nothing; `prepare` runs first in the
  // same transaction.
  createMany(
    inputs: CreateIssueInput[],
    prepare?: (tx: AnyDb) => Promise<void>,
  ): Promise<IssueDocument[]> {
    return this.creation.createMany(inputs, prepare);
  }

  update(id: string, input: UpdateIssueInput): Promise<IssueDocument> {
    return this.updates.update(id, input);
  }

  bulkUpdate(
    ids: string[],
    patch: BulkUpdateIssueInput,
  ): Promise<BulkUpdateResult> {
    return this.updates.bulkUpdate(ids, patch);
  }

  move(
    id: string,
    statusId: string,
    beforeId?: string | null,
    afterId?: string | null,
  ): Promise<IssueDocument> {
    return this.moves.move(id, statusId, beforeId, afterId);
  }

  // Answers the issue's id. Its children lose their parent; a Sub-task would
  // be left without one, so it becomes a Task (one activity row each).
  async delete(id: string): Promise<string> {
    const current = await this.project.byId(id);
    await this.project.inProject(current.projectId, async (tx, _, changed) => {
      await tx.db.issues.hardDelete(current._id);
      await changed("deleted", current, []);
      await issueRemoved(tx as IssuesMongo, current.id);
      const children = await tx.db.issues.findMany({
        filter: { parentId: current._id },
      });
      for (const child of children) {
        const patch = orphanPatch(child);
        const updated = await tx.db.issues.update(child._id, patch);
        const changes = changesBetween(child, updated, ["type", "parentId"]);
        if (changes.length > 0) await changed("updated", updated, changes);
      }
    });
    return current.id;
  }

  // Repeatable, and so is its reverse.
  async setWatching(id: string, watching: boolean): Promise<IssueDocument> {
    const current = await this.project.byId(id);
    return this.project.inProject(
      current.projectId,
      async (tx) => {
        const issue = await tx.db.issues.findById(current._id);
        if (!issue) throw issueNotFound();
        if (issue.watcherIds.includes(this.viewerId) === watching) return issue;
        return tx.db.issues.update(issue._id, {
          watcherIds: watching
            ? [...issue.watcherIds, this.viewerId]
            : issue.watcherIds.filter((account) => account !== this.viewerId),
        });
      },
      { archivedOk: true },
    );
  }
}

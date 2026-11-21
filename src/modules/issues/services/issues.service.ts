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
  ) {
    this.project = new IssuesProject(mongo, isMember, viewerId, organisationId);
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

  // Answers the issue's id; its children lose their parent.
  async delete(id: string): Promise<string> {
    const current = await this.project.byId(id);
    await this.project.inProject(current.projectId, async (tx, _, changed) => {
      await tx.db.issues.hardDelete(current._id);
      await changed("deleted", current, []);
      await issueRemoved(tx as IssuesMongo, current.id);
      await tx.db.issues.updateMany(
        { parentId: current._id },
        { parentId: null },
      );
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

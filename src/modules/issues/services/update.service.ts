import { changesBetween } from "../../../core/shared/changes";
import { invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { issueNotFound } from "../issues.errors";
import { type IssueDocument, typeOf } from "../issues.model";
import type {
  BulkUpdateIssueInput,
  BulkUpdateResult,
  IssuesMongo,
  UpdateIssueInput,
} from "../issues.types";
import { invalidField } from "../issues.validation";
import { bulkIssues, updateIssues } from "../utils/checks.utils";
import { optionalId, TRACKED, updatedFields } from "../utils/fields.utils";
import { failureOf, labelChanges, patchInput } from "../utils/patch.utils";
import type { IssuesProject } from "./issues-project.service";
import type { IssueMoves } from "./move.service";

// The edits of an issue, one by one and in bulk.
export class IssueUpdates {
  constructor(
    private readonly project: IssuesProject,
    private readonly moves: IssueMoves,
  ) {}

  // A field left out stays as it is; null clears `assigneeId`, `parentId`,
  // `startDate` and `dueDate`, and is refused for the others. The status
  // changes by `moveIssue`.
  async update(id: string, input: UpdateIssueInput): Promise<IssueDocument> {
    const refused = updateIssues(input);
    if (refused.length > 0) throw invalid(refused);
    const current = await this.project.byId(id);
    return this.project.inProject(current.projectId, async (tx, _, changed) => {
      const issue = await tx.db.issues.findById(current._id);
      if (!issue) throw issueNotFound();
      await this.project.checkReferences(tx, issue.projectId, {
        assigneeId: input.assigneeId,
        labelIds: input.labelIds,
        parentId: input.parentId,
        startDate:
          input.startDate !== undefined ? input.startDate : issue.startDate,
        dueDate: input.dueDate !== undefined ? input.dueDate : issue.dueDate,
      });
      if (input.parentId) {
        await this.project.checkNoLoop(
          tx,
          issue._id,
          idOrInvalid(input.parentId, "parentId"),
        );
      }
      await this.checkTypeRules(tx, issue, input);
      const updated = await tx.db.issues.update(
        issue._id,
        updatedFields(input, issue),
      );
      const changes = changesBetween(issue, updated, TRACKED);
      if (changes.length > 0) await changed("updated", updated, changes);
      return updated;
    });
  }

  // The parent rules, for the pair the edit changes: a type given that is the
  // current one, or a parent that is the same, is no change, so a link that
  // already broke the rules survives an unrelated edit.
  private async checkTypeRules(
    tx: IssuesMongo,
    issue: IssueDocument,
    input: UpdateIssueInput,
  ): Promise<void> {
    const from = typeOf(issue);
    const to = input.type ?? from;
    const parentId =
      input.parentId === undefined
        ? issue.parentId
        : optionalId(input.parentId, "parentId");
    const parentMoved =
      (parentId?.toHexString() ?? null) !==
      (issue.parentId?.toHexString() ?? null);
    if (to !== from || parentMoved) {
      await this.project.checkParentRules(tx, to, parentId);
    }
    if (to !== from) {
      await this.project.checkChildrenRules(tx, issue._id, from, to);
    }
  }

  // Applies one patch to many issues, each through `update` (and `move` for
  // the status), so each has its own checks, activity row and live event. An
  // issue that is refused is reported in `failures`; the others are written.
  async bulkUpdate(
    ids: string[],
    patch: BulkUpdateIssueInput,
  ): Promise<BulkUpdateResult> {
    const refused = bulkIssues(patch);
    if (refused.length > 0) throw invalid(refused);
    const { add, remove } = labelChanges(patch);
    const statusId = optionalId(patch.statusId, "statusId");
    const result: BulkUpdateResult = { updated: [], failures: [] };
    for (const id of new Set(ids)) {
      try {
        result.updated.push(
          await this.applyPatch(id, patch, { add, remove, statusId }),
        );
      } catch (error) {
        result.failures.push(failureOf(id, error));
      }
    }
    return result;
  }

  private async applyPatch(
    id: string,
    patch: BulkUpdateIssueInput,
    parts: {
      add: ReturnType<typeof labelChanges>["add"];
      remove: Set<string>;
      statusId: ReturnType<typeof optionalId>;
    },
  ): Promise<IssueDocument> {
    const { add, remove, statusId } = parts;
    let issue = await this.project.byId(id);
    if (statusId) {
      // Refused before any write, so a refused status leaves the issue as is.
      const status = await this.project.mongo.db.statuses.findById(statusId);
      if (!status?.projectId.equals(issue.projectId)) {
        throw invalid([invalidField("statusId")]);
      }
    }
    const input = patchInput(patch, issue, add, remove);
    if (Object.keys(input).length > 0) issue = await this.update(id, input);
    if (statusId && !issue.statusId.equals(statusId)) {
      issue = await this.moves.move(id, statusId.toHexString());
    }
    return issue;
  }
}

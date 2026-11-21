import type { ObjectId } from "mongodb";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../../core/shared/after-commit";
import {
  exhausted,
  type FieldIssue,
  invalid,
} from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { retryWriteConflicts } from "../../../core/shared/locked";
import { lockProject, type ProjectDocument } from "../../projects/public";
import { issueNotFound, parentCycle, projectArchived } from "../issues.errors";
import type { IssueDocument } from "../issues.model";
import type { Changed, IsMember, IssuesMongo } from "../issues.types";
import { issueChanged } from "../issues.usage";
import { distinct, invalidField } from "../issues.validation";
import { rankAfter } from "../rank";

// The fields that name other records, checked against the issue's project.
export interface ReferenceFields {
  assigneeId?: string | null | undefined;
  labelIds?: string[] | null | undefined;
  parentId?: string | null | undefined;
  startDate?: Date | null | undefined;
  dueDate?: Date | null | undefined;
}

// Every write of a project's issues runs in one transaction that locks the
// project (`lockProject`), so numbers, ranks and the checks against the
// workflow are serialised per project: two writers never read the same
// "last" and a status or label cannot go while an issue lands on it.
export class IssuesProject {
  constructor(
    readonly mongo: IssuesMongo,
    private readonly isMember: IsMember,
    readonly viewerId: string,
    private readonly organisationId: string,
  ) {}

  async byKey(key: string): Promise<IssueDocument> {
    const found = await this.mongo.db.issues.findFirst({
      key: key.trim().toUpperCase(),
    });
    if (!found) throw issueNotFound();
    return found;
  }

  async byId(id: string): Promise<IssueDocument> {
    const found = await this.mongo.db.issues.findById(idOrInvalid(id, "id"));
    if (!found) throw issueNotFound();
    return found;
  }

  // Runs `work` in a transaction holding the project's lock. What `changed`
  // reports is written inside it by the registered handlers; their live events
  // go out once it has committed (the attempt that committed only).
  async inProject<T>(
    projectId: ObjectId,
    work: (
      tx: IssuesMongo,
      project: ProjectDocument,
      changed: Changed,
    ) => Promise<T>,
    // Watching is a viewer's own mark, not a change of the issue.
    options: { archivedOk?: boolean } = {},
  ): Promise<T> {
    let later: AfterCommit[] = [];
    const result = await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          later = [];
          const project = await lockProject(tx, projectId);
          if (project.archivedAt && !options.archivedOk) {
            throw projectArchived();
          }
          const changed: Changed = async (verb, issue, changes) => {
            later.push(
              ...(await issueChanged(tx as IssuesMongo, {
                verb,
                issue,
                changes,
                actorId: this.viewerId,
                organisationId: this.organisationId,
              })),
            );
          };
          return work(tx as IssuesMongo, project, changed);
        }),
      exhausted,
    );
    await runAfterCommit(later);
    return result;
  }

  async checkReferences(
    tx: IssuesMongo,
    projectId: ObjectId,
    fields: ReferenceFields,
  ): Promise<void> {
    const issues: FieldIssue[] = [];
    if (fields.assigneeId && !(await this.isMember(fields.assigneeId))) {
      issues.push(invalidField("assigneeId"));
    }
    if (fields.labelIds && fields.labelIds.length > 0) {
      const ids = distinct(fields.labelIds, "labelIds");
      const found = await tx.db.labels.count({
        _id: { $in: ids },
        projectId,
      });
      if (found !== ids.length) issues.push(invalidField("labelIds"));
    }
    if (fields.parentId) {
      const parent = await tx.db.issues.findById(
        idOrInvalid(fields.parentId, "parentId"),
      );
      if (!parent?.projectId.equals(projectId)) {
        issues.push(invalidField("parentId"));
      }
    }
    if (
      fields.startDate &&
      fields.dueDate &&
      fields.startDate.getTime() > fields.dueDate.getTime()
    ) {
      issues.push(invalidField("dueDate"));
    }
    if (issues.length > 0) throw invalid(issues);
  }

  // The parent chain of `parentId` must not come back to the issue.
  async checkNoLoop(
    tx: IssuesMongo,
    issueId: ObjectId,
    parentId: ObjectId,
  ): Promise<void> {
    let current: ObjectId | null = parentId;
    for (let hops = 0; current && hops < 1000; hops++) {
      if (current.equals(issueId)) throw parentCycle();
      const next: IssueDocument | undefined =
        await tx.db.issues.findById(current);
      current = next?.parentId ?? null;
    }
  }

  // The end of a status's column: the rank after its last issue.
  async endOfColumn(
    tx: IssuesMongo,
    statusId: ObjectId,
    except?: ObjectId,
  ): Promise<string> {
    const last = await tx.db.issues.findMany({
      filter: { statusId, ...(except && { _id: { $ne: except } }) },
      sort: { rank: -1 },
      limit: 1,
    });
    return rankAfter(last[0]?.rank ?? null);
  }
}

import { ConflictError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import {
  changesBetween,
  changesFromNothing,
  type FieldChange,
} from "../../core/shared/changes";
import {
  exhausted,
  type FieldIssue,
  invalid,
  required,
} from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { retryWriteConflicts } from "../../core/shared/locked";
import { lockProject, type ProjectDocument } from "../projects/public";
import {
  badPlacement,
  issueNotFound,
  parentCycle,
  projectArchived,
} from "./issues.errors";
import {
  type IssueDocument,
  type Priority,
  priorityLevel,
} from "./issues.model";
import { type IssueChange, issueChanged, issueRemoved } from "./issues.usage";
import { distinct, estimateIssue, invalidField } from "./issues.validation";
import { rankAfter, rankBetween } from "./rank";

export type IssuesMongo = ModuleMongo<"issues">;

// Whether an account is a member of the organisation: an assignee must be.
export type IsMember = (accountId: string) => Promise<boolean>;

export interface CreateIssueInput {
  projectId: string;
  title: string;
  description?: string | null;
  statusId?: string | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  labelIds?: string[] | null;
  parentId?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  estimateHours?: number | null;
  // Set by the intake module only (never by GraphQL's `CreateIssueInput`): the
  // client report this issue is made from.
  clientReportId?: ObjectId | null;
}

export interface UpdateIssueInput {
  title?: string | null;
  description?: string | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  labelIds?: string[] | null;
  parentId?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  estimateHours?: number | null;
}

// One patch for many issues. A field left out stays; null clears `assigneeId`,
// `dueDate` and `estimateHours`.
export interface BulkUpdateIssueInput {
  statusId?: string | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  addLabelIds?: string[] | null;
  removeLabelIds?: string[] | null;
  dueDate?: Date | null;
  estimateHours?: number | null;
}

export interface BulkIssueFailure {
  id: string;
  code: string;
  message: string;
}

export interface BulkUpdateResult {
  updated: IssueDocument[];
  failures: BulkIssueFailure[];
}

// The fields whose change the activity journal records. A move is the status
// and the rank.
const TRACKED = [
  "title",
  "description",
  "priority",
  "assigneeId",
  "labelIds",
  "parentId",
  "startDate",
  "dueDate",
  "estimateHours",
] as const;
const CREATED = [...TRACKED, "statusId"] as const;
const MOVED = ["statusId", "rank"] as const;

// Tells the registered handlers (the activity journal) what the transaction
// changed; they write inside it.
type Changed = (
  verb: IssueChange["verb"],
  issue: IssueDocument,
  changes: FieldChange[],
) => Promise<void>;

// Every write of a project's issues runs in one transaction that locks the
// project (`lockProject`), so numbers, ranks and the checks against the
// workflow are serialised per project: two writers never read the same
// "last" and a status or label cannot go while an issue lands on it.
export class IssuesService {
  constructor(
    private readonly mongo: IssuesMongo,
    private readonly isMember: IsMember,
    private readonly viewerId: string,
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
  private async inProject<T>(
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

  // The fields that name other records, checked against the issue's project.
  private async checkReferences(
    tx: IssuesMongo,
    projectId: ObjectId,
    fields: {
      assigneeId?: string | null | undefined;
      labelIds?: string[] | null | undefined;
      parentId?: string | null | undefined;
      startDate?: Date | null | undefined;
      dueDate?: Date | null | undefined;
    },
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
  private async checkNoLoop(
    tx: IssuesMongo,
    issueId: ObjectId,
    parentId: ObjectId,
  ) {
    let current: ObjectId | null = parentId;
    for (let hops = 0; current && hops < 1000; hops++) {
      if (current.equals(issueId)) throw parentCycle();
      const next: IssueDocument | undefined =
        await tx.db.issues.findById(current);
      current = next?.parentId ?? null;
    }
  }

  // The end of a status's column: the rank after its last issue.
  private async endOfColumn(
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

  async create(input: CreateIssueInput): Promise<IssueDocument> {
    const title = input.title.trim();
    if (!title) {
      throw invalid([{ path: "title", code: "validation.errors.required" }]);
    }
    const projectId = idOrInvalid(input.projectId, "projectId");
    if (
      input.estimateHours != null &&
      estimateIssue(input.estimateHours).length
    ) {
      throw invalid(estimateIssue(input.estimateHours));
    }
    const statusId = input.statusId
      ? idOrInvalid(input.statusId, "statusId")
      : null;
    return this.inProject(projectId, async (tx, project, changed) => {
      const status = statusId
        ? await tx.db.statuses.findById(statusId)
        : await defaultStatus(tx, projectId);
      if (!status?.projectId.equals(projectId)) {
        throw invalid([invalidField("statusId")]);
      }
      await this.checkReferences(tx, projectId, input);

      const counter = await tx.db.issueCounters.findFirst({ projectId });
      const number = (counter?.last ?? 0) + 1;
      if (counter)
        await tx.db.issueCounters.update(counter._id, { last: number });
      else await tx.db.issueCounters.create({ projectId, last: number });

      const level = input.priority ?? "none";
      try {
        const created = await tx.db.issues.create({
          projectId,
          number,
          key: `${project.key}-${number}`,
          title,
          description: input.description?.trim() ?? "",
          statusId: status._id,
          priority: level,
          priorityLevel: priorityLevel[level],
          assigneeId: input.assigneeId ?? null,
          labelIds: distinct(input.labelIds ?? [], "labelIds"),
          parentId: input.parentId
            ? idOrInvalid(input.parentId, "parentId")
            : null,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          estimateHours: input.estimateHours ?? null,
          rank: await this.endOfColumn(tx, status._id),
          reporterId: this.viewerId,
          clientReportId: input.clientReportId ?? null,
          watcherIds: [],
        });
        await changed("created", created, changesFromNothing(created, CREATED));
        return created;
      } catch (error) {
        // Cannot happen under the project's lock; kept as a refusal, not a 500.
        if (error instanceof ConflictError) throw exhausted();
        throw error;
      }
    });
  }

  // A field left out stays as it is; null clears `assigneeId`, `parentId`,
  // `startDate` and `dueDate`, and is refused for the others. The status
  // changes by `moveIssue`.
  async update(id: string, input: UpdateIssueInput): Promise<IssueDocument> {
    const issues: FieldIssue[] = required(input, [
      "title",
      "description",
      "priority",
      "labelIds",
    ]);
    const title = input.title?.trim();
    if (title === "") {
      issues.push({ path: "title", code: "validation.errors.required" });
    }
    issues.push(...estimateIssue(input.estimateHours));
    if (issues.length > 0) throw invalid(issues);
    const current = await this.byId(id);
    return this.inProject(current.projectId, async (tx, _, changed) => {
      const issue = await tx.db.issues.findById(current._id);
      if (!issue) throw issueNotFound();
      const startDate =
        input.startDate !== undefined ? input.startDate : issue.startDate;
      const dueDate =
        input.dueDate !== undefined ? input.dueDate : issue.dueDate;
      await this.checkReferences(tx, issue.projectId, {
        assigneeId: input.assigneeId,
        labelIds: input.labelIds,
        parentId: input.parentId,
        startDate,
        dueDate,
      });
      if (input.parentId) {
        await this.checkNoLoop(
          tx,
          issue._id,
          idOrInvalid(input.parentId, "parentId"),
        );
      }
      const updated = await tx.db.issues.update(issue._id, {
        ...(title && { title }),
        ...(input.description != null && {
          description: input.description.trim(),
        }),
        ...(input.priority != null && {
          priority: input.priority,
          priorityLevel: priorityLevel[input.priority],
        }),
        ...(input.assigneeId !== undefined && {
          assigneeId: input.assigneeId,
        }),
        ...(input.labelIds != null && {
          labelIds: distinct(input.labelIds, "labelIds"),
        }),
        ...(input.parentId !== undefined && {
          parentId: input.parentId
            ? idOrInvalid(input.parentId, "parentId")
            : null,
        }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
        ...(input.estimateHours !== undefined && {
          estimateHours: input.estimateHours,
        }),
      });
      const changes = changesBetween(issue, updated, TRACKED);
      if (changes.length > 0) await changed("updated", updated, changes);
      return updated;
    });
  }

  // Applies one patch to many issues, each through `update` (and `move` for
  // the status), so each has its own checks, activity row and live event. An
  // issue that is refused is reported in `failures`; the others are written.
  async bulkUpdate(
    ids: string[],
    patch: BulkUpdateIssueInput,
  ): Promise<BulkUpdateResult> {
    const issues: FieldIssue[] = required(patch, ["statusId", "priority"]);
    issues.push(...estimateIssue(patch.estimateHours));
    const fields = [
      patch.statusId,
      patch.priority,
      patch.assigneeId,
      patch.addLabelIds,
      patch.removeLabelIds,
      patch.dueDate,
      patch.estimateHours,
    ];
    if (fields.every((field) => field === undefined)) {
      issues.push({ path: "input", code: "validation.errors.required" });
    }
    if (issues.length > 0) throw invalid(issues);
    const add = distinct(patch.addLabelIds ?? [], "addLabelIds");
    const remove = new Set(
      distinct(patch.removeLabelIds ?? [], "removeLabelIds").map((id) =>
        id.toHexString(),
      ),
    );
    const statusId = patch.statusId
      ? idOrInvalid(patch.statusId, "statusId")
      : null;
    const result: BulkUpdateResult = { updated: [], failures: [] };
    for (const id of new Set(ids)) {
      try {
        result.updated.push(
          await this.applyPatch(id, patch, add, remove, statusId),
        );
      } catch (error) {
        if (!(error instanceof GraphQLError)) throw error;
        result.failures.push({
          id,
          code: String(error.extensions["code"] ?? "unknown"),
          message: error.message,
        });
      }
    }
    return result;
  }

  private async applyPatch(
    id: string,
    patch: BulkUpdateIssueInput,
    add: ObjectId[],
    remove: Set<string>,
    statusId: ObjectId | null,
  ): Promise<IssueDocument> {
    let issue = await this.byId(id);
    if (statusId) {
      // Refused before any write, so a refused status leaves the issue as is.
      const status = await this.mongo.db.statuses.findById(statusId);
      if (!status?.projectId.equals(issue.projectId)) {
        throw invalid([invalidField("statusId")]);
      }
    }
    const labels = patch.addLabelIds != null || patch.removeLabelIds != null;
    const input: UpdateIssueInput = {
      ...(patch.priority != null && { priority: patch.priority }),
      ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }),
      ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }),
      ...(patch.estimateHours !== undefined && {
        estimateHours: patch.estimateHours,
      }),
      ...(labels && {
        labelIds: [
          ...new Set(
            [...issue.labelIds, ...add]
              .map((label) => label.toHexString())
              .filter((label) => !remove.has(label)),
          ),
        ],
      }),
    };
    if (Object.keys(input).length > 0) issue = await this.update(id, input);
    if (statusId && !issue.statusId.equals(statusId)) {
      issue = await this.move(id, statusId.toHexString());
    }
    return issue;
  }

  // Puts the issue in a status's column, right after `beforeId` and right
  // before `afterId` (the issues that end up above and below it; either or
  // both may be left out). With neither it goes to the end of the column.
  // Only the moved issue is written.
  async move(
    id: string,
    statusId: string,
    beforeId?: string | null,
    afterId?: string | null,
  ): Promise<IssueDocument> {
    const target = idOrInvalid(statusId, "statusId");
    const before = beforeId ? idOrInvalid(beforeId, "beforeId") : null;
    const after = afterId ? idOrInvalid(afterId, "afterId") : null;
    const current = await this.byId(id);
    return this.inProject(current.projectId, async (tx, _, changed) => {
      const issue = await tx.db.issues.findById(current._id);
      if (!issue) throw issueNotFound();
      const status = await tx.db.statuses.findById(target);
      if (!status?.projectId.equals(issue.projectId)) {
        throw invalid([invalidField("statusId")]);
      }
      const neighbour = async (neighbourId: ObjectId | null) => {
        if (!neighbourId) return null;
        const found = await tx.db.issues.findById(neighbourId);
        if (
          !found ||
          found._id.equals(issue._id) ||
          !found.statusId.equals(status._id)
        ) {
          throw badPlacement();
        }
        return found;
      };
      const above = await neighbour(before);
      const below = await neighbour(after);
      const column = { statusId: status._id, _id: { $ne: issue._id } };
      let rank: string | null;
      if (above) {
        // Right after `above`, whatever stands between it and `below` (a
        // client that read the column a moment ago): never a rank another
        // issue already has.
        const [next] = await tx.db.issues.findMany({
          filter: { ...column, rank: { $gt: above.rank } },
          sort: { rank: 1 },
          limit: 1,
        });
        const upper = [next?.rank, below?.rank]
          .filter((rank): rank is string => rank !== undefined)
          .sort()[0];
        rank = rankBetween(above.rank, upper ?? null);
      } else if (below) {
        const [previous] = await tx.db.issues.findMany({
          filter: { ...column, rank: { $lt: below.rank } },
          sort: { rank: -1 },
          limit: 1,
        });
        rank = rankBetween(previous?.rank ?? null, below.rank);
      } else {
        rank = await this.endOfColumn(tx, status._id, issue._id);
      }
      if (rank === null) throw badPlacement();
      const moved = await tx.db.issues.update(issue._id, {
        statusId: status._id,
        rank,
      });
      const changes = changesBetween(issue, moved, MOVED);
      if (changes.length > 0) await changed("moved", moved, changes);
      return moved;
    });
  }

  // Answers the issue's id; its children lose their parent.
  async delete(id: string): Promise<string> {
    const current = await this.byId(id);
    await this.inProject(current.projectId, async (tx, _, changed) => {
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
    const current = await this.byId(id);
    return this.inProject(
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

// Where an issue lands without a status: the first backlog status of the
// workflow, else its first.
async function defaultStatus(tx: IssuesMongo, projectId: ObjectId) {
  const statuses = await tx.db.statuses.findMany({
    filter: { projectId },
    sort: { order: 1 },
  });
  return statuses.find((s) => s.category === "backlog") ?? statuses[0];
}

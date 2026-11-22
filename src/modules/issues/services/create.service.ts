import { ConflictError } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { AnyDb } from "../../../config/db";
import { changesFromNothing } from "../../../core/shared/changes";
import { exhausted, invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import type { ProjectDocument } from "../../projects/public";
import type { IssueDocument } from "../issues.model";
import type { Changed, CreateIssueInput, IssuesMongo } from "../issues.types";
import { invalidField } from "../issues.validation";
import { createIssues } from "../utils/checks.utils";
import { CREATED, newIssue, optionalId } from "../utils/fields.utils";
import type { IssuesProject } from "./issues-project.service";

// The creation of an issue: its number, its status, its place in the column.
export class IssueCreation {
  constructor(private readonly project: IssuesProject) {}

  async create(input: CreateIssueInput): Promise<IssueDocument> {
    const [created] = await this.createMany([input]);
    return created as IssueDocument;
  }

  // Several issues of one project in one transaction: all or nothing. `prepare`
  // runs first, inside it (the intake claims its report there), so a refusal
  // anywhere undoes it as well.
  async createMany(
    inputs: CreateIssueInput[],
    prepare?: (tx: AnyDb) => Promise<void>,
  ): Promise<IssueDocument[]> {
    const first = inputs[0];
    if (!first) return [];
    for (const input of inputs) {
      const refused = createIssues(input);
      if (refused.length > 0) throw invalid(refused);
    }
    const projectId = idOrInvalid(first.projectId, "projectId");
    return this.project.inProject(projectId, async (tx, project, changed) => {
      await prepare?.(tx as unknown as AnyDb);
      const made: IssueDocument[] = [];
      for (const input of inputs) {
        made.push(await this.createIn(tx, project, changed, input));
      }
      return made;
    });
  }

  private async createIn(
    tx: IssuesMongo,
    project: ProjectDocument,
    changed: Changed,
    input: CreateIssueInput,
  ): Promise<IssueDocument> {
    const projectId = project._id;
    const statusId = optionalId(input.statusId, "statusId");
    const status = statusId
      ? await tx.db.statuses.findById(statusId)
      : await this.defaultStatus(tx, projectId);
    if (!status?.projectId.equals(projectId)) {
      throw invalid([invalidField("statusId")]);
    }
    await this.project.checkReferences(tx, projectId, input);
    await this.project.checkParentRules(
      tx,
      input.type ?? "task",
      optionalId(input.parentId, "parentId"),
    );
    const number = await this.nextNumber(tx, projectId);
    try {
      const created = await tx.db.issues.create(
        newIssue(input, {
          projectId,
          statusId: status._id,
          number,
          key: `${project.key}-${number}`,
          rank: await this.project.endOfColumn(tx, status._id),
          reporterId: this.project.viewerId,
        }),
      );
      await changed("created", created, changesFromNothing(created, CREATED));
      return created;
    } catch (error) {
      // Cannot happen under the project's lock; kept as a refusal, not a 500.
      if (error instanceof ConflictError) throw exhausted();
      throw error;
    }
  }

  // Where an issue lands without a status: the first backlog status of the
  // workflow, else its first.
  private async defaultStatus(tx: IssuesMongo, projectId: ObjectId) {
    const statuses = await tx.db.statuses.findMany({
      filter: { projectId },
      sort: { order: 1 },
    });
    return statuses.find((s) => s.category === "backlog") ?? statuses[0];
  }

  // The project's next gap-free number.
  private async nextNumber(tx: IssuesMongo, projectId: ObjectId) {
    const counter = await tx.db.issueCounters.findFirst({ projectId });
    const number = (counter?.last ?? 0) + 1;
    if (counter)
      await tx.db.issueCounters.update(counter._id, { last: number });
    else await tx.db.issueCounters.create({ projectId, last: number });
    return number;
  }
}

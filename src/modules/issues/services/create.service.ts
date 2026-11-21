import { ConflictError } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { changesFromNothing } from "../../../core/shared/changes";
import { exhausted, invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import type { IssueDocument } from "../issues.model";
import type { CreateIssueInput, IssuesMongo } from "../issues.types";
import { invalidField } from "../issues.validation";
import { createIssues } from "../utils/checks.utils";
import { CREATED, newIssue, optionalId } from "../utils/fields.utils";
import type { IssuesProject } from "./issues-project.service";

// The creation of an issue: its number, its status, its place in the column.
export class IssueCreation {
  constructor(private readonly project: IssuesProject) {}

  async create(input: CreateIssueInput): Promise<IssueDocument> {
    const refused = createIssues(input);
    if (refused.length > 0) throw invalid(refused);
    const projectId = idOrInvalid(input.projectId, "projectId");
    const statusId = optionalId(input.statusId, "statusId");
    return this.project.inProject(projectId, async (tx, project, changed) => {
      const status = statusId
        ? await tx.db.statuses.findById(statusId)
        : await this.defaultStatus(tx, projectId);
      if (!status?.projectId.equals(projectId)) {
        throw invalid([invalidField("statusId")]);
      }
      await this.project.checkReferences(tx, projectId, input);
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
    });
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

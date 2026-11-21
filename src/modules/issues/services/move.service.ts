import type { ObjectId } from "mongodb";
import { changesBetween } from "../../../core/shared/changes";
import { invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { badPlacement, issueNotFound } from "../issues.errors";
import type { IssueDocument } from "../issues.model";
import type { IssuesMongo } from "../issues.types";
import { invalidField } from "../issues.validation";
import { rankBetween } from "../rank";
import { MOVED, optionalId } from "../utils/fields.utils";
import type { IssuesProject } from "./issues-project.service";

// The move of an issue to a place in a status's column.
export class IssueMoves {
  constructor(private readonly project: IssuesProject) {}

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
    const before = optionalId(beforeId, "beforeId");
    const after = optionalId(afterId, "afterId");
    const current = await this.project.byId(id);
    return this.project.inProject(current.projectId, async (tx, _, changed) => {
      const issue = await tx.db.issues.findById(current._id);
      if (!issue) throw issueNotFound();
      const status = await tx.db.statuses.findById(target);
      if (!status?.projectId.equals(issue.projectId)) {
        throw invalid([invalidField("statusId")]);
      }
      const above = await this.neighbour(tx, before, issue, status._id);
      const below = await this.neighbour(tx, after, issue, status._id);
      const rank = await this.rankFor(tx, issue, status._id, above, below);
      const moved = await tx.db.issues.update(issue._id, {
        statusId: status._id,
        rank,
      });
      const changes = changesBetween(issue, moved, MOVED);
      if (changes.length > 0) await changed("moved", moved, changes);
      return moved;
    });
  }

  // The issue a placement names: in the target column, and not the moved one.
  private async neighbour(
    tx: IssuesMongo,
    neighbourId: ObjectId | null,
    issue: IssueDocument,
    statusId: ObjectId,
  ): Promise<IssueDocument | null> {
    if (!neighbourId) return null;
    const found = await tx.db.issues.findById(neighbourId);
    if (
      !found ||
      found._id.equals(issue._id) ||
      !found.statusId.equals(statusId)
    ) {
      throw badPlacement();
    }
    return found;
  }

  // The rank of the moved issue among its new column's.
  private async rankFor(
    tx: IssuesMongo,
    issue: IssueDocument,
    statusId: ObjectId,
    above: IssueDocument | null,
    below: IssueDocument | null,
  ): Promise<string> {
    const column = { statusId, _id: { $ne: issue._id } };
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
      rank = await this.project.endOfColumn(tx, statusId, issue._id);
    }
    if (rank === null) throw badPlacement();
    return rank;
  }
}

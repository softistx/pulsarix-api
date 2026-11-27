import type { ObjectId } from "mongodb";
import type { AfterCommit } from "../../../core/shared/after-commit";
import { changesBetween } from "../../../core/shared/changes";
import { badPlacement } from "../issues.errors";
import { type IssueDocument, planRankOf } from "../issues.model";
import type { IssuesMongo } from "../issues.types";
import { issueChanged } from "../issues.usage";
import { rankBetween } from "../rank";
import { PLANNED } from "../utils/fields.utils";

// Where the planned issues go among those of their sprint (or of the backlog):
// right after `afterId` and right before `beforeId`, either or both left out.
// With neither they go to the end.
export interface Placement {
  afterId?: ObjectId | null;
  beforeId?: ObjectId | null;
}

// The writes of planning (sprints module): which sprint an issue is in, and its
// place there. The sprints module checks the sprint and the issues; this
// service owns the issues' fields, their ranks and their activity.
export class IssuePlanning {
  constructor(
    private readonly viewerId: string,
    private readonly organisationId: string,
  ) {}

  // Puts `issues` (one project's, in the order given) in the sprint, `null`
  // being the backlog, at the placement. Each is written once, so an issue
  // already there only changes place. Runs inside the caller's transaction,
  // under the project's lock; the returned work goes out after the commit.
  async place(
    tx: IssuesMongo,
    issues: IssueDocument[],
    sprintId: ObjectId | null,
    placement: Placement = {},
  ): Promise<{ issues: IssueDocument[]; later: AfterCommit[] }> {
    const first = issues[0];
    if (!first) return { issues: [], later: [] };
    const scope = { projectId: first.projectId, sprintId };
    const moved = issues.map((issue) => issue._id);
    const bounds = await this.bounds(tx, scope, moved, placement);
    const result: IssueDocument[] = [];
    const later: AfterCommit[] = [];
    let lower = bounds.lower;
    for (const issue of issues) {
      const planRank = rankBetween(lower, bounds.upper);
      if (planRank === null) throw badPlacement();
      lower = planRank;
      const updated = await tx.db.issues.update(issue._id, {
        sprintId,
        planRank,
      });
      const changes = changesBetween(issue, updated, PLANNED);
      if (changes.length > 0) {
        later.push(
          ...(await issueChanged(tx, {
            verb: "updated",
            issue: updated,
            changes,
            actorId: this.viewerId,
            organisationId: this.organisationId,
          })),
        );
      }
      result.push(updated);
    }
    return { issues: result, later };
  }

  // The ranks the planned issues fit between: the neighbours named (in the
  // target scope, not among the moved), widened to whatever stands next to
  // them, so that no issue already there gets the same rank.
  private async bounds(
    tx: IssuesMongo,
    scope: { projectId: ObjectId; sprintId: ObjectId | null },
    moved: ObjectId[],
    placement: Placement,
  ): Promise<{ lower: string | null; upper: string | null }> {
    const others = { ...scope, _id: { $nin: moved } };
    const above = await this.neighbour(tx, scope, moved, placement.afterId);
    const below = await this.neighbour(tx, scope, moved, placement.beforeId);
    if (above) {
      const lower = planRankOf(above);
      const [next] = await tx.db.issues.findMany({
        filter: { ...others, planRank: { $gt: lower } },
        sort: { planRank: 1 },
        limit: 1,
      });
      const upper = [next?.planRank, below && planRankOf(below)]
        .filter((rank): rank is string => rank !== undefined && rank !== null)
        .sort()[0];
      return { lower, upper: upper ?? null };
    }
    if (below) {
      const upper = planRankOf(below);
      const [previous] = await tx.db.issues.findMany({
        filter: { ...others, planRank: { $lt: upper } },
        sort: { planRank: -1 },
        limit: 1,
      });
      return { lower: previous?.planRank ?? null, upper };
    }
    const [last] = await tx.db.issues.findMany({
      filter: others,
      sort: { planRank: -1 },
      limit: 1,
    });
    return { lower: last?.planRank ?? null, upper: null };
  }

  private async neighbour(
    tx: IssuesMongo,
    scope: { projectId: ObjectId; sprintId: ObjectId | null },
    moved: ObjectId[],
    id: ObjectId | null | undefined,
  ): Promise<IssueDocument | null> {
    if (!id) return null;
    const found = await tx.db.issues.findFirst({ ...scope, _id: id });
    if (!found || moved.some((m) => m.equals(found._id))) throw badPlacement();
    return found;
  }
}

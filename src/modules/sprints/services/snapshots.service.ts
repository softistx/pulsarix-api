import { ConflictError } from "@softistx/mongo";
import { addDays, dayIn, startOfDayIn } from "../../../core/shared/days";
import type {
  SnapshotReason,
  SprintDocument,
  SprintSnapshotDocument,
} from "../sprints.model";
import type { SprintsMongo } from "../sprints.types";
import { pointsOf } from "../sprints.utils";

export interface SprintFigures {
  scopePoints: number;
  completedPoints: number;
  scopeIssues: number;
  completedIssues: number;
}

// The burndown's log: what a sprint's scope and done work are, written when
// the sprint starts, changes scope, closes, and each day.
export class SprintSnapshots {
  constructor(
    private readonly mongo: SprintsMongo,
    private readonly timeZone: string,
  ) {}

  // The figures of `sprint` as its issues stand now.
  async measure(sprint: SprintDocument): Promise<SprintFigures> {
    const issues = await this.mongo.db.issues.findMany({
      filter: { sprintId: sprint._id },
    });
    const statuses = await this.mongo.db.statuses.findMany({
      filter: { projectId: sprint.projectId },
    });
    const category = new Map(
      statuses.map((s) => [s._id.toHexString(), s.category]),
    );
    const counted = issues.filter(
      (issue) => category.get(issue.statusId.toHexString()) !== "cancelled",
    );
    const done = counted.filter(
      (issue) => category.get(issue.statusId.toHexString()) === "done",
    );
    return {
      scopePoints: pointsOf(counted),
      completedPoints: pointsOf(done),
      scopeIssues: counted.length,
      completedIssues: done.length,
    };
  }

  // Appends a snapshot of `sprint` as its issues stand now (inside the
  // caller's transaction when `mongo` is one).
  async take(
    sprint: SprintDocument,
    reason: SnapshotReason,
    now: Date,
    day = dayIn(this.timeZone, now),
  ): Promise<SprintSnapshotDocument> {
    return this.mongo.db.sprintSnapshots.create({
      sprintId: sprint._id,
      projectId: sprint.projectId,
      day,
      reason,
      takenAt: now,
      ...(await this.measure(sprint)),
    });
  }

  // The snapshot of the day that ended, once, when the organisation's day has
  // turned since the sprint started. True when it made one.
  async daily(sprint: SprintDocument, now: Date): Promise<boolean> {
    const today = dayIn(this.timeZone, now);
    const yesterday = addDays(today, -1);
    const started = sprint.startDate && dayIn(this.timeZone, sprint.startDate);
    if (!started || started > yesterday) return false;
    const exists = await this.mongo.db.sprintSnapshots.exists({
      sprintId: sprint._id,
      day: yesterday,
      reason: "daily",
    });
    if (exists) return false;
    try {
      await this.take(
        sprint,
        "daily",
        startOfDayIn(this.timeZone, now),
        yesterday,
      );
      return true;
    } catch (error) {
      // Another run made it first.
      if (error instanceof ConflictError) return false;
      throw error;
    }
  }
}

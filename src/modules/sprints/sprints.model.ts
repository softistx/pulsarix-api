import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { actors } from "../../core/shared/actors";

export const sprintState = z.enum(["planned", "active", "closed"]);
export type SprintState = z.infer<typeof sprintState>;

// A time-boxed iteration of a project, in the organisation's database.
// `planned` sprints collect issues, one is `active` at a time, `closed` ones
// are history. `committedPoints` is the scope snapshot of the start;
// `completedPoints` the points of the done issues at the close.
export const sprints = defineCollection({
  name: "sprints",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    number: z.number().int().min(1),
    name: z.string().trim().min(1).max(100),
    goal: z.string().trim().max(1000).nullable().default(null),
    state: sprintState.default("planned"),
    startDate: z.date().nullable().default(null),
    endDate: z.date().nullable().default(null),
    closedAt: z.date().nullable().default(null),
    committedPoints: z.number().int().min(0).default(0),
    completedPoints: z.number().int().min(0).default(0),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { projectId: 1, number: 1 },
      unique: true,
      name: "sprints_projectIdNumberUnique",
    },
    // One active sprint per project, whatever the code does.
    {
      key: { projectId: 1 },
      unique: true,
      partialFilterExpression: { state: "active" },
      name: "sprints_projectIdActiveUnique",
    },
  ],
});
export type SprintDocument = ReadDocumentOf<typeof sprints>;

export const snapshotReason = z.enum(["start", "scope", "daily", "close"]);
export type SnapshotReason = z.infer<typeof snapshotReason>;

// The burndown's log (plan §28): what a sprint's scope and done work were at a
// moment. One is taken when the sprint starts, when its scope changes, when it
// closes, and daily at the organisation's midnight. `day` is the organisation
// day the snapshot counts toward (`YYYY-MM-DD`): an event's own day, and for the
// daily one the day that just ended. Points are the sprint's issues' points,
// cancelled issues left out of the scope; an unestimated issue counts for none.
export const sprintSnapshots = defineCollection({
  name: "sprintSnapshots",
  schema: z.object({
    _id: id(),
    sprintId: objectId(),
    projectId: objectId(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: snapshotReason,
    takenAt: z.date(),
    scopePoints: z.number().int().min(0),
    completedPoints: z.number().int().min(0),
    scopeIssues: z.number().int().min(0),
    completedIssues: z.number().int().min(0),
  }),
  indexes: [
    {
      key: { sprintId: 1, day: 1, takenAt: 1 },
      name: "sprintSnapshots_sprintIdDayTakenAt",
    },
    // One daily snapshot per sprint and day, whatever runs the job twice.
    {
      key: { sprintId: 1, day: 1 },
      unique: true,
      partialFilterExpression: { reason: "daily" },
      name: "sprintSnapshots_sprintIdDayDailyUnique",
    },
  ],
});
export type SprintSnapshotDocument = ReadDocumentOf<typeof sprintSnapshots>;

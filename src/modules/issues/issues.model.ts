import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

export const priority = z.enum(["none", "low", "medium", "high", "urgent"]);
export type Priority = z.infer<typeof priority>;

// The kind of an issue (plan §20.3): one set for every project. Parent rules
// are in issues.rules.ts.
export const issueType = z.enum(["epic", "story", "task", "bug", "subTask"]);
export type IssueType = z.infer<typeof issueType>;

// The story-point scale (plan §20.5) and the types that carry points.
export const pointScale = [1, 2, 3, 5, 8, 13, 21] as const;
export const pointTypes: readonly IssueType[] = ["story", "task", "bug"];

// What a reporter did to the issue's requests (plan §19), shown to the team.
export const clientMarker = z.enum(["resolved", "reopened", "deleted"]);
export type ClientMarker = z.infer<typeof clientMarker>;

// Where an issue's priority came from (plan §19): `client` is the reporter's
// impact, prefilled when the report was accepted; `team` is anything a member
// set or changed (and what every issue made by a member starts as); `auto` is
// kept for the later automatic level.
export const priorityOrigin = z.enum(["client", "team", "auto"]);
export type PriorityOrigin = z.infer<typeof priorityOrigin>;

// The weight of a priority, so that a sort by priority is numeric
// (`none` 0 ... `urgent` 4); stored beside the name and kept in step with it.
export const priorityLevel: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

// An issue of a project, in the organisation's database. `number` counts from
// 1 per project, with no gap, and `key` is `<project key>-<number>`. `rank` is
// a fractional index (rank.ts): the order of the issue among those of its
// status, the board's column.
export const issues = defineCollection({
  name: "issues",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    number: z.number().int().min(1),
    key: z.string().min(3).max(20),
    title: z.string().trim().min(1).max(200),
    // Rich text, kept as the client sends it.
    description: z.string().max(50_000).default(""),
    statusId: objectId(),
    // Issues stored before the types lack it: read `type ?? "task"` (typeOf).
    type: issueType.optional(),
    priority: priority.default("none"),
    priorityLevel: z.number().int().min(0).max(4).default(0),
    // Issues stored before widget v3 lack it: read it as `team`.
    priorityOrigin: priorityOrigin.optional(),
    assigneeId: accountId.nullable().default(null),
    labelIds: z.array(objectId()).default([]),
    parentId: objectId().nullable().default(null),
    startDate: z.date().nullable().default(null),
    dueDate: z.date().nullable().default(null),
    // The estimate in hours (time tracking, P1); the time spent is chronix's.
    estimateHours: z.number().min(0).max(100_000).nullable().default(null),
    // Story points (plan §20.5): Fibonacci 1 to 21 (`pointScale`), on a Story,
    // a Task or a Bug only; null is none. Issues stored before lack it.
    points: z.number().int().nullable().default(null),
    rank: z.string().min(1).max(200),
    // The sprint the issue is planned in (sprints module); null is the
    // backlog. Issues stored before sprints lack it: read `sprintId ?? null`.
    sprintId: objectId().nullable().default(null),
    // Its place among the issues of its sprint (or of the backlog), a
    // fractional rank like `rank`. Issues stored before sprints get theirs
    // from a migration (their `rank`): read `planRank ?? rank` (planRankOf).
    planRank: z.string().min(1).max(200).optional(),
    // The member who made it.
    reporterId: accountId.nullable().default(null),
    // The client report it was accepted from (intake, A9), if any.
    clientReportId: objectId().nullable().default(null),
    watcherIds: z.array(accountId).default([]),
    // A reporter wrote last on one of its client reports and no public reply
    // has answered since (plan §19, A16). Issues stored before lack it: read
    // `clientWaiting === true`.
    clientWaiting: z.boolean().default(false),
    // What the reporters did to the issue's requests (plan §19, A17): the
    // latest of "resolved" and "reopened", and "deleted" once one erased their
    // data. Issues stored before lack it: read `clientMarkers ?? []`.
    clientMarkers: z.array(clientMarker).default([]),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { projectId: 1, number: 1 },
      unique: true,
      name: "issues_projectIdNumberUnique",
    },
    { key: { key: 1 }, unique: true, name: "issues_keyUnique" },
    {
      key: { projectId: 1, statusId: 1, rank: 1 },
      name: "issues_projectIdStatusIdRank",
    },
    // The backlog and the sprints: the issues of a sprint in plan order.
    {
      key: { projectId: 1, sprintId: 1, planRank: 1 },
      name: "issues_projectIdSprintIdPlanRank",
    },
    { key: { parentId: 1 }, name: "issues_parentId" },
    { key: { projectId: 1, type: 1 }, name: "issues_projectIdType" },
    // The "client replied" filter of the issue list.
    {
      key: { projectId: 1, clientWaiting: 1 },
      partialFilterExpression: { clientWaiting: true },
      name: "issues_projectIdClientWaiting",
    },
    { key: { labelIds: 1 }, name: "issues_labelIds" },
    { key: { projectId: 1, dueDate: 1 }, name: "issues_projectIdDueDate" },
    // Home's figures per project, read from the index alone (no FETCH), and
    // the viewer's open assigned issues (the dashboard module).
    {
      key: { projectId: 1, statusId: 1, priorityLevel: 1, dueDate: 1 },
      name: "issues_projectIdStatusIdPriorityDue",
    },
    {
      key: { assigneeId: 1, statusId: 1 },
      name: "issues_assigneeIdStatusId",
    },
    // Search (A8): no stemming nor stop words, so French and English alike.
    {
      key: { title: "text", key: "text", description: "text" },
      weights: { title: 10, key: 10, description: 1 },
      default_language: "none",
      name: "issues_text",
    },
  ],
});
export type IssueDocument = ReadDocumentOf<typeof issues>;

// The type of a stored issue: one stored before the types is a task.
export const typeOf = (issue: { type?: IssueType | undefined }): IssueType =>
  issue.type ?? "task";

// The plan rank of a stored issue: one stored before sprints has none yet.
export const planRankOf = (issue: {
  planRank?: string | undefined;
  rank: string;
}): string => issue.planRank ?? issue.rank;

// The last number given in a project: the next issue is the one after it.
// Written only under the project's lock, so two issues never share a number.
export const issueCounters = defineCollection({
  name: "issueCounters",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    last: z.number().int().min(0),
  }),
  timestamps: true,
  actors,
  indexes: [
    {
      key: { projectId: 1 },
      unique: true,
      name: "issueCounters_projectIdUnique",
    },
  ],
});

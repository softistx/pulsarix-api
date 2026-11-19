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
    rank: z.string().min(1).max(200),
    // The member who made it.
    reporterId: accountId.nullable().default(null),
    // The client report it was accepted from (intake, A9), if any.
    clientReportId: objectId().nullable().default(null),
    watcherIds: z.array(accountId).default([]),
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
    { key: { parentId: 1 }, name: "issues_parentId" },
    { key: { labelIds: 1 }, name: "issues_labelIds" },
    { key: { projectId: 1, dueDate: 1 }, name: "issues_projectIdDueDate" },
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

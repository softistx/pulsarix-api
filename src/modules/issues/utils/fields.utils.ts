import type { ObjectId } from "mongodb";
import { idOrInvalid } from "../../../core/shared/ids";
import {
  type IssueDocument,
  type Priority,
  priorityLevel,
  typeOf,
} from "../issues.model";
import type { CreateIssueInput, UpdateIssueInput } from "../issues.types";
import { distinct } from "../issues.validation";

// The fields whose change the activity journal records. A move is the status
// and the rank.
export const TRACKED = [
  "title",
  "type",
  "description",
  "priority",
  "assigneeId",
  "labelIds",
  "parentId",
  "startDate",
  "dueDate",
  "estimateHours",
  "points",
] as const;
export const CREATED = [...TRACKED, "statusId"] as const;
export const MOVED = ["statusId", "rank"] as const;

// A value that is neither left out (undefined) nor cleared (null).
export function isSet<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

// An id given as a string, as an ObjectId; an empty one is no id.
export function optionalId(
  id: string | null | undefined,
  path: string,
): ObjectId | null {
  return id ? idOrInvalid(id, path) : null;
}

// The fields of a new issue.
export function newIssue(
  input: CreateIssueInput,
  place: {
    projectId: ObjectId;
    statusId: ObjectId;
    number: number;
    key: string;
    rank: string;
    reporterId: string;
  },
) {
  const level: Priority = input.priority ?? "none";
  return {
    projectId: place.projectId,
    number: place.number,
    key: place.key,
    title: input.title.trim(),
    type: input.type ?? ("task" as const),
    description: input.description?.trim() ?? "",
    statusId: place.statusId,
    priority: level,
    priorityLevel: priorityLevel[level],
    priorityOrigin: input.priorityOrigin ?? ("team" as const),
    assigneeId: input.assigneeId ?? null,
    labelIds: distinct(input.labelIds ?? [], "labelIds"),
    parentId: optionalId(input.parentId, "parentId"),
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    estimateHours: input.estimateHours ?? null,
    points: input.points ?? null,
    rank: place.rank,
    reporterId: place.reporterId,
    clientReportId: input.clientReportId ?? null,
    watcherIds: [],
  };
}

// What an update writes: a field left out stays as it is.
export function updatedFields(input: UpdateIssueInput, issue: IssueDocument) {
  const title = input.title?.trim();
  return {
    ...(title && { title }),
    // A type equal to the effective one (a legacy issue reads as a task) is no change.
    ...(isSet(input.type) &&
      input.type !== typeOf(issue) && { type: input.type }),
    ...(isSet(input.description) && { description: input.description.trim() }),
    ...(isSet(input.priority) && {
      priority: input.priority,
      priorityLevel: priorityLevel[input.priority],
      // A member who changes the priority owns it from then on.
      ...(input.priority !== issue.priority && {
        priorityOrigin: "team" as const,
      }),
    }),
    ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
    ...(isSet(input.labelIds) && {
      labelIds: distinct(input.labelIds, "labelIds"),
    }),
    ...(input.parentId !== undefined && {
      parentId: optionalId(input.parentId, "parentId"),
    }),
    ...(input.startDate !== undefined && { startDate: input.startDate }),
    ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
    ...(input.estimateHours !== undefined && {
      estimateHours: input.estimateHours,
    }),
    ...(input.points !== undefined && { points: input.points }),
  };
}

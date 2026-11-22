import { GraphQLError } from "graphql";
import type { ObjectId } from "mongodb";
import type { IssueDocument } from "../issues.model";
import type {
  BulkIssueFailure,
  BulkUpdateIssueInput,
  UpdateIssueInput,
} from "../issues.types";
import { distinct } from "../issues.validation";
import { isSet } from "./fields.utils";

// The refusal of one issue of a bulk update, as the answer reports it; what
// is not a refusal goes on.
export function failureOf(id: string, error: unknown): BulkIssueFailure {
  if (!(error instanceof GraphQLError)) throw error;
  return {
    id,
    code: String(error.extensions["code"] ?? "unknown"),
    message: error.message,
  };
}

// The labels of a bulk patch: the ids to add and the hex ids to remove.
export function labelChanges(patch: BulkUpdateIssueInput) {
  return {
    add: distinct(patch.addLabelIds ?? [], "addLabelIds"),
    remove: new Set(
      distinct(patch.removeLabelIds ?? [], "removeLabelIds").map((id) =>
        id.toHexString(),
      ),
    ),
  };
}

// The `update` input one issue gets from a bulk patch (the status aside).
export function patchInput(
  patch: BulkUpdateIssueInput,
  issue: IssueDocument,
  add: ObjectId[],
  remove: Set<string>,
): UpdateIssueInput {
  const labels = isSet(patch.addLabelIds) || isSet(patch.removeLabelIds);
  return {
    ...(isSet(patch.priority) && { priority: patch.priority }),
    ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }),
    ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }),
    ...(patch.estimateHours !== undefined && {
      estimateHours: patch.estimateHours,
    }),
    ...(patch.points !== undefined && { points: patch.points }),
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
}

import type { FieldIssue } from "../../../core/shared/errors";
import { required } from "../../../core/shared/errors";
import type {
  BulkUpdateIssueInput,
  CreateIssueInput,
  UpdateIssueInput,
} from "../issues.types";
import { estimateIssue } from "../issues.validation";

// The refusal of a creation made before any write: the title first, then the
// estimate.
export function createIssues(input: CreateIssueInput): FieldIssue[] {
  if (!input.title.trim()) {
    return [{ path: "title", code: "validation.errors.required" }];
  }
  return estimateIssue(input.estimateHours);
}

// The refusals of an update made before any write.
export function updateIssues(input: UpdateIssueInput): FieldIssue[] {
  const issues: FieldIssue[] = required(input, [
    "title",
    "type",
    "description",
    "priority",
    "labelIds",
  ]);
  if (input.title?.trim() === "") {
    issues.push({ path: "title", code: "validation.errors.required" });
  }
  issues.push(...estimateIssue(input.estimateHours));
  return issues;
}

// The refusals of a bulk patch made before any write.
export function bulkIssues(patch: BulkUpdateIssueInput): FieldIssue[] {
  const issues: FieldIssue[] = required(patch, ["statusId", "priority"]);
  issues.push(...estimateIssue(patch.estimateHours));
  const fields = [
    patch.statusId,
    patch.priority,
    patch.assigneeId,
    patch.addLabelIds,
    patch.removeLabelIds,
    patch.dueDate,
    patch.estimateHours,
  ];
  if (fields.every((field) => field === undefined)) {
    issues.push({ path: "input", code: "validation.errors.required" });
  }
  return issues;
}

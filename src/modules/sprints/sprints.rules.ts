import type { FieldIssue } from "../../core/shared/errors";

// An end that is before the start is refused on `endDate`.
export function datesIssues(
  startDate: Date | null,
  endDate: Date | null,
): FieldIssue[] {
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    return [{ path: "endDate", code: "validation.errors.invalid" }];
  }
  return [];
}

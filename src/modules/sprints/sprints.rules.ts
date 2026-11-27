import { MS_PER_DAY } from "../../core/shared/days";
import type { FieldIssue } from "../../core/shared/errors";

// The longest a sprint runs (the four-week default length, twice over); it
// bounds the burndown's day-by-day loop.
export const MAX_SPRINT_DAYS = 8 * 7;

// An end that is before the start, or more than eight weeks after it, is
// refused on `endDate`.
export function datesIssues(
  startDate: Date | null,
  endDate: Date | null,
): FieldIssue[] {
  if (!startDate || !endDate) return [];
  const length = endDate.getTime() - startDate.getTime();
  if (length < 0 || length > MAX_SPRINT_DAYS * MS_PER_DAY) {
    return [{ path: "endDate", code: "validation.errors.invalid" }];
  }
  return [];
}

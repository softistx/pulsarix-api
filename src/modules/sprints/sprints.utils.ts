import { type IssueType, typeOf } from "../issues/public";
import type { StatusCategory } from "../projects/public";

const DAY = 86_400_000;

// A sprint named in the order it was made, until the team names it.
export const defaultName = (number: number) => `Sprint ${number}`;

// The end of a sprint started on `start`, `weeks` weeks long: the same weekday
// of the last week, so a two-week sprint of a Monday ends on the Monday after.
export const defaultEnd = (start: Date, weeks: number) =>
  new Date(start.getTime() + weeks * 7 * DAY);

// The categories whose issues leave a closing sprint where they are.
const FINISHED: readonly StatusCategory[] = ["done", "cancelled"];

export const isFinished = (category: StatusCategory) =>
  FINISHED.includes(category);

// The sum of the points of issues; an unestimated issue counts for none.
export const pointsOf = (issues: readonly { points?: number | null }[]) =>
  issues.reduce((sum, issue) => sum + (issue.points ?? 0), 0);

// Epics and sub-tasks are not planned: an epic spans sprints, a sub-task follows
// its parent.
const UNPLANNED: readonly IssueType[] = ["epic", "subTask"];

export const plannable = (
  issues: readonly { type?: IssueType | undefined }[],
) => issues.every((issue) => !UNPLANNED.includes(typeOf(issue)));

// The points still to do on the ideal line: the committed scope falls evenly
// to nothing by the last day. `index` counts days from the start's day, `last`
// is the end's.
export const idealRemaining = (
  committed: number,
  index: number,
  last: number,
) =>
  last <= 0 || index >= last
    ? 0
    : Math.round(committed * (1 - index / last) * 100) / 100;

// The mean of the values, to one decimal; 0 with none.
export const averageOf = (values: readonly number[]) =>
  values.length === 0
    ? 0
    : Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
      ) / 10;

// The snapshot a day ends with: the latest one counted to that day or before
// (by day, then by when it was taken), null before the first.
export function latestUpTo<T extends { day: string; takenAt: Date }>(
  snapshots: readonly T[],
  day: string,
): T | null {
  let found: T | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.day > day) continue;
    if (
      !found ||
      snapshot.day > found.day ||
      (snapshot.day === found.day && snapshot.takenAt >= found.takenAt)
    ) {
      found = snapshot;
    }
  }
  return found;
}

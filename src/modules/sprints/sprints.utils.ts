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

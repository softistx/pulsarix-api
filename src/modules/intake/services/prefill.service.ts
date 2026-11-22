import type { IssuesService } from "../../issues/public";
import type { ClientReportDocument, ReportImpact, ReportType } from "../models";

type IssueInput = Parameters<IssuesService["create"]>[0];

// What the reporter's impact prefills (plan §16, Q27): the priority of the
// issue an acceptance makes. Urgent stays the team's call, so a blocking
// request is High.
export const priorityOfImpact: Record<
  ReportImpact,
  NonNullable<IssueInput["priority"]>
> = {
  blocking: "high",
  annoying: "medium",
  minor: "low",
};

// The issue type a report type becomes (plan §20, A22): a report with no type
// is a Task. No label is made for it.
export const issueTypeOf: Record<
  ReportType,
  NonNullable<IssueInput["type"]>
> = {
  bug: "bug",
  suggestion: "story",
  question: "task",
};

// What an acceptance adds to the issue's input from the report: the priority
// of its impact (origin `client`, which becomes `team` once a member changes
// it) and the issue type of its report type (Task when it has none).
export function prefillOf(report: ClientReportDocument): Partial<IssueInput> {
  return {
    ...(report.impact && {
      priority: priorityOfImpact[report.impact],
      priorityOrigin: "client" as const,
    }),
    type: report.type ? issueTypeOf[report.type] : "task",
  };
}

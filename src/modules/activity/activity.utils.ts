import type { ClientRequestChange } from "@/generated/graphql/resolvers";
import type { IssueEventPayload } from "./activity.channels";
import type { ActivityDocument } from "./activity.model";

// The issue events go out after the commit, from the row the journal wrote.
export const eventOf = (
  organisationId: string,
  activity: ActivityDocument,
  issue: { statusId: string | null; rank: string | null },
): IssueEventPayload => ({
  organisationId,
  activityId: activity.id,
  verb: activity.verb,
  projectId: activity.projectId.toHexString(),
  issueId: activity.issueId?.toHexString() ?? "",
  issueKey: activity.issueKey ?? "",
  actorId: activity.actorId,
  fields: activity.changes.map((change) => change.field),
  statusId: issue.statusId,
  rank: issue.rank,
  at: activity.at.toISOString(),
});

// A stored event as the subscription answers it: its time is a date.
export const issueEvent = (event: { at: string; [key: string]: unknown }) => ({
  ...event,
  at: new Date(event.at),
});

const REQUEST_CHANGES: Record<
  "new" | "message" | "state",
  ClientRequestChange
> = {
  new: "NEW",
  message: "MESSAGE",
  state: "STATE",
};

// A triage-stream event as the subscription answers it: its kind in capitals,
// its time a date.
export const requestsEvent = (event: {
  reportId: string;
  projectId: string;
  kind: keyof typeof REQUEST_CHANGES;
  at: string;
}) => ({
  reportId: event.reportId,
  projectId: event.projectId,
  kind: REQUEST_CHANGES[event.kind],
  at: new Date(event.at),
});

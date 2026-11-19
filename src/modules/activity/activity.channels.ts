import { defineChannel } from "@softistx/redis";
import { z } from "zod";
import { activityVerb } from "./activity.model";

// The live topics of plan §9. Redis pub/sub carries them across API instances;
// each channel is read by key, `<organisation id>:<id>`, so a subscriber hears
// one organisation's project, issue or member and nothing else. A message is
// fire-and-forget: a client that missed one refetches (the event names the
// activity row that was written). With Redis unreachable the publishing
// process still reaches its own subscribers (`fallback: 'local'`).

// What happened to an issue, for the board and for the issue's own page.
const issueEvent = z.object({
  organisationId: z.string(),
  activityId: z.string(),
  verb: activityVerb,
  projectId: z.string(),
  issueId: z.string(),
  issueKey: z.string(),
  actorId: z.string(),
  // The fields the change touched, and where the issue now stands.
  fields: z.array(z.string()),
  statusId: z.string().nullable(),
  rank: z.string().nullable(),
  at: z.string(),
});
export type IssueEventPayload = z.infer<typeof issueEvent>;

// `project.board`: issue created, updated, moved, deleted.
export const projectBoard = defineChannel({
  name: "project.board",
  schema: issueEvent,
  key: (event) => `${event.organisationId}:${event.projectId}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

// `issue.changed`: field changes and comments of one issue.
export const issueChanged = defineChannel({
  name: "issue.changed",
  schema: issueEvent,
  key: (event) => `${event.organisationId}:${event.issueId}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

// `member.notifications`: a new notification and the unread count (published
// by the notifications slice).
export const notificationReceived = defineChannel({
  name: "member.notifications",
  schema: z.object({
    organisationId: z.string(),
    memberId: z.string(),
    notificationId: z.string(),
    kind: z.string(),
    unreadCount: z.number().int().min(0),
  }),
  key: (event) => `${event.organisationId}:${event.memberId}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

// `project.intake.file`: a file of a client report was stored (A12).
export const clientReportFileReceived = defineChannel({
  name: "project.intake.file",
  schema: z.object({
    organisationId: z.string(),
    projectId: z.string(),
    reportId: z.string(),
    fileId: z.string(),
    role: z.enum(["screenshot", "file"]),
    at: z.string(),
  }),
  key: (event) => `${event.organisationId}:${event.projectId}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

// `project.intake.message`: a reporter wrote in the thread of a request (A16).
export const clientReportMessageReceived = defineChannel({
  name: "project.intake.message",
  schema: z.object({
    organisationId: z.string(),
    projectId: z.string(),
    reportId: z.string(),
    messageId: z.string(),
    at: z.string(),
  }),
  key: (event) => `${event.organisationId}:${event.projectId}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

// `project.intake`: a new client report (published by the intake slice).
export const clientReportReceived = defineChannel({
  name: "project.intake",
  schema: z.object({
    organisationId: z.string(),
    projectId: z.string(),
    reportId: z.string(),
    title: z.string(),
    at: z.string(),
  }),
  key: (event) => `${event.organisationId}:${event.projectId}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

// `reporter.request`: a request of an identified reporter changed (a public
// reply, a state change, a decision, their own mark from another tab). Keyed by
// the key and the reporter, so a stream hears its own reporter's requests and
// nobody else's; it names the report only, the stream reads the rest (A17).
export const reporterRequestChanged = defineChannel({
  name: "reporter.request",
  schema: z.object({
    organisationId: z.string(),
    keyId: z.string(),
    reporterKey: z.string(),
    reportId: z.string(),
    at: z.string(),
  }),
  key: (event) => `${event.keyId}:${event.reporterKey}`,
  fallback: "local",
  onNoLocalReader: "drop",
});

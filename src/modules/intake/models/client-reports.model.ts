import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../core/shared/actors";
import { publicState } from "../../projects/public";

export const reportState = z.enum(["new", "accepted", "declined", "closed"]);
export type ReportState = z.infer<typeof reportState>;

export const reportLocale = z.enum(["en", "fr"]);

// What the reporter says about the request (plan §19, Q27). `impact` prefills
// the priority of the issue an acceptance makes; `type` becomes a label.
export const reportImpact = z.enum(["blocking", "annoying", "minor"]);
export type ReportImpact = z.infer<typeof reportImpact>;
export const reportType = z.enum(["bug", "question", "suggestion"]);
export type ReportType = z.infer<typeof reportType>;

// A report a reader of a host page sent through the widget, in the
// organisation's database. Text only: nothing in it is rendered as markup.
// `trackingTokenHash` is the SHA-256 of the secret part of the tracking token
// (the token itself is mailed once, never stored). `email`, `userAgent` and
// the token hash are erased 90 days after the report is closed or declined
// (retention job; `erasedAt`). `issueId` is the issue an acceptance made.
export const clientReports = defineCollection({
  name: "clientReports",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    widgetKeyId: objectId(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10_000),
    email: z.string().max(254).nullable().default(null),
    // The reporter an identity token vouched for (plan §19): the SHA-256 of
    // the key id and the token's `sub`, never the raw user id; the name as the
    // token gave it. Null for a report sent with no token.
    reporterKey: z.string().length(64).nullable().default(null),
    reporterName: z.string().max(100).nullable().default(null),
    impact: reportImpact.nullable().default(null),
    type: reportType.nullable().default(null),
    trackingTokenHash: z.string().length(64).nullable().default(null),
    state: reportState.default("new"),
    issueId: objectId().nullable().default(null),
    declineReason: z.string().max(1_000).nullable().default(null),
    // Whether the reporter reads the decline reason. True for a decline made
    // since widget v3 (the dialog says so); reports declined before lack the
    // field and keep their reason hidden: read it with `declineReasonShown`.
    declineReasonPublic: z.boolean().default(false),
    // When the report was linked to an existing issue (a duplicate).
    linkedAt: z.date().nullable().default(null),
    // The reporter's own marks (plan §19): resolved, and reopened within 30
    // days. `reopenedFrom` is the public state the issue had at the reopen, so
    // the report reads "in progress" until the issue's state next changes.
    resolvedByReporterAt: z.date().nullable().default(null),
    reopenedAt: z.date().nullable().default(null),
    reopenedFrom: publicState.nullable().default(null),
    // The reporter's thread (plan §19, A16): when they last read it (the
    // unread count is the team's public replies since), and whether they
    // wrote last: set by a reporter's message, cleared by a public reply.
    // Reports stored before A16 lack both: read `clientWaiting === true`.
    reporterReadAt: z.date().nullable().default(null),
    clientWaiting: z.boolean().default(false),
    // The reporter turned the e-mails of their requests off (the widget's or
    // the tracking page's toggle; the e-mails are A19). Reports stored before
    // A17 lack it: read `emailsOff === true`.
    emailsOff: z.boolean().default(false),
    // The reporter's e-mails (A19, services/notify.service.ts): the tracking token,
    // sealed (the later mails link to the tracking page; null for a report
    // made before A19, whose mails carry no link), the moment up to which the
    // team's public replies were mailed, and the public state the last mail
    // told. Absent on reports stored before A19.
    trackingTokenSealed: z.string().nullable().default(null),
    mailedThrough: z.date().nullable().default(null),
    mailedState: publicState.nullable().default(null),
    pageUrl: z.string().max(2_048).nullable().default(null),
    userAgent: z.string().max(512).nullable().default(null),
    locale: reportLocale.default("en"),
    metadata: z
      .array(
        z.object({
          key: z.string().max(64),
          value: z.string().max(512),
        }),
      )
      .max(20)
      .default([]),
    decidedBy: accountId.nullable().default(null),
    decidedAt: z.date().nullable().default(null),
    closedAt: z.date().nullable().default(null),
    erasedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { projectId: 1, state: 1, _id: -1 },
      name: "clientReports_projectIdStateId",
    },
    {
      key: { trackingTokenHash: 1 },
      unique: true,
      partialFilterExpression: { trackingTokenHash: { $type: "string" } },
      name: "clientReports_trackingTokenHashUnique",
    },
    { key: { issueId: 1 }, name: "clientReports_issueId" },
    // A reporter's own requests (the later "My requests" reads).
    {
      key: { widgetKeyId: 1, reporterKey: 1, _id: -1 },
      name: "clientReports_widgetKeyIdReporterKey",
    },
    // The retention job: what was settled, and not erased yet.
    {
      key: { erasedAt: 1, state: 1, decidedAt: 1, closedAt: 1 },
      name: "clientReports_retention",
    },
  ],
});
export type ClientReportDocument = ReadDocumentOf<typeof clientReports>;

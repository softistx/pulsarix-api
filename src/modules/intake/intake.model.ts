import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

// What a widget key is spelled like: `pk_live_` and 32 URL-safe characters
// (192 bits). Public by design (plan §11): it names a project, it opens nothing.
export const PUBLIC_KEY = /^pk_live_[A-Za-z0-9_-]{32}$/;

// An origin as a browser sends it in `Origin`: scheme, host and port, nothing
// else, in the one text `URL.origin` gives.
export const origin = z.string().min(8).max(200);

// A widget key, in the CORE database: the public endpoint finds the
// organisation and the project of a key before it knows which organisation
// database to open (plan §6, "the widget-key index"), and the team lists and
// edits the same documents. `allowedOrigins` is required (at least one);
// `active` is the admin's "disable key" switch (the key answers `enabled:
// false`); `revokedAt` retires the key for good (it answers like an unknown
// one). `lastUsedAt` is kept to the minute.
export const widgetKeys = defineCollection({
  name: "widgetKeys",
  schema: z.object({
    _id: id(),
    organisationId: objectId(),
    projectId: objectId(),
    publicKey: z.string().regex(PUBLIC_KEY),
    label: z.string().trim().min(1).max(100),
    allowedOrigins: z.array(origin).min(1).max(20),
    active: z.boolean().default(true),
    revokedAt: z.date().nullable().default(null),
    lastUsedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { publicKey: 1 }, unique: true, name: "widgetKeys_publicKeyUnique" },
    {
      key: { organisationId: 1, projectId: 1, _id: 1 },
      name: "widgetKeys_organisationIdProjectId",
    },
    // The preflight asks whether any live key allows an origin.
    { key: { allowedOrigins: 1 }, name: "widgetKeys_allowedOrigins" },
  ],
});
export type WidgetKeyDocument = ReadDocumentOf<typeof widgetKeys>;

export const reportState = z.enum(["new", "accepted", "declined", "closed"]);
export type ReportState = z.infer<typeof reportState>;

export const reportLocale = z.enum(["en", "fr"]);

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
    trackingTokenHash: z.string().length(64).nullable().default(null),
    state: reportState.default("new"),
    issueId: objectId().nullable().default(null),
    declineReason: z.string().max(1_000).nullable().default(null),
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
    // The retention job: what was settled, and not erased yet.
    {
      key: { erasedAt: 1, state: 1, decidedAt: 1, closedAt: 1 },
      name: "clientReports_retention",
    },
  ],
});
export type ClientReportDocument = ReadDocumentOf<typeof clientReports>;

export const reportFileRole = z.enum(["screenshot", "file"]);
export type ReportFileRole = z.infer<typeof reportFileRole>;

// Where a file stands. `pending`: the slot is reserved, the bytes may still
// come (until `expiresAt`). `quarantined`: stored, readable only by the team,
// never shown to the reporter beyond thumbnails. `released`: its report was
// accepted and the files show on the issue.
export const reportFileState = z.enum(["pending", "quarantined", "released"]);
export type ReportFileState = z.infer<typeof reportFileState>;

// A file a reader attached to a client report, in the organisation's database.
// The bytes live in the `report-files` media kind under
// `organisations/<id>/report-files/<storageKey>[/<size>]` (src/modules/intake/
// intake.files.kinds.ts): a picture is kept as renditions only (`full`, at most
// 2560 px, and the 256 px `256` thumbnail), a PDF as `file` plus its first-page
// `256` preview. `storageKey`, `previewKey`, `width` and `height` are null until
// the bytes are stored (and always for what has none: a PDF has no size in
// pixels). `expiresAt` is the pending slot's deadline, null once it is stored.
export const clientReportFiles = defineCollection({
  name: "clientReportFiles",
  schema: z.object({
    _id: id(),
    reportId: objectId(),
    role: reportFileRole,
    fileName: z.string().trim().min(1).max(200),
    mime: z.string().min(1).max(100),
    size: z.number().int().min(0),
    storageKey: z.uuid().nullable().default(null),
    previewKey: z.string().min(1).max(20).nullable().default(null),
    width: z.number().int().min(1).nullable().default(null),
    height: z.number().int().min(1).nullable().default(null),
    state: reportFileState.default("pending"),
    expiresAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  indexes: [
    { key: { reportId: 1, _id: 1 }, name: "clientReportFiles_reportIdId" },
    // The purge of pending slots.
    {
      key: { state: 1, expiresAt: 1 },
      name: "clientReportFiles_stateExpiresAt",
    },
    {
      key: { storageKey: 1 },
      unique: true,
      partialFilterExpression: { storageKey: { $type: "string" } },
      name: "clientReportFiles_storageKeyUnique",
    },
  ],
});
export type ClientReportFileDocument = ReadDocumentOf<typeof clientReportFiles>;

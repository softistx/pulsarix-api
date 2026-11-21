import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";

// What a reader declares a file to be when sending a report or a reply: the
// widget's two controls. A file sent in a reply is stored with the role `reply`.
export const declaredFileRole = z.enum(["screenshot", "file"]);
export const reportFileRole = z.enum(["screenshot", "file", "reply"]);
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
// pixels). `expiresAt` is the pending slot's deadline, null once it is stored (a stored file of a deleted
// issue carries its removal date there, until the purge).
export const clientReportFiles = defineCollection({
  name: "clientReportFiles",
  schema: z.object({
    _id: id(),
    reportId: objectId(),
    role: reportFileRole,
    // The reporter's message a `reply` file belongs to (clientReportMessages).
    messageId: objectId().nullable().optional(),
    fileName: z.string().trim().min(1).max(200),
    mime: z.string().min(1).max(100),
    size: z.number().int().min(0),
    storageKey: z.uuid().nullable().default(null),
    previewKey: z.string().min(1).max(20).nullable().default(null),
    width: z.number().int().min(1).nullable().default(null),
    height: z.number().int().min(1).nullable().default(null),
    state: reportFileState.default("pending"),
    expiresAt: z.date().nullable().default(null),
    // When an upload took the slot: one at a time (a lease of a minute), and
    // released when it fails, so a retry is possible until `expiresAt`.
    claimedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  indexes: [
    { key: { reportId: 1, _id: 1 }, name: "clientReportFiles_reportIdId" },
    // The files of a thread's messages.
    {
      key: { messageId: 1 },
      partialFilterExpression: { messageId: { $type: "objectId" } },
      name: "clientReportFiles_messageId",
    },
    // The purge of pending slots.
    {
      key: { state: 1, expiresAt: 1 },
      name: "clientReportFiles_stateExpiresAt",
    },
    // The quarantine's byte sum is read from this index alone (covered).
    { key: { state: 1, size: 1 }, name: "clientReportFiles_stateSize" },
    {
      key: { storageKey: 1 },
      unique: true,
      partialFilterExpression: { storageKey: { $type: "string" } },
      name: "clientReportFiles_storageKeyUnique",
    },
  ],
});
export type ClientReportFileDocument = ReadDocumentOf<typeof clientReportFiles>;

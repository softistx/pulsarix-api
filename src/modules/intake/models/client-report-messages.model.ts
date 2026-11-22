import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../core/shared/actors";

// What a reporter may write in one message of their request thread.
export const MAX_MESSAGE = 5_000;

// A message the reporter wrote in the thread of their request (plan §19), in
// the organisation's database: the reporter's side of the thread. Plain text,
// nothing in it is rendered as markup. `fileIds` are the `reply` files it
// carries (clientReportFiles, `messageId` points back). The team reads it as a
// read-only `source: CLIENT` comment of the issue (comments.sources.ts); it is
// not stored a second time. `erasedAt` is stamped when the reporter's data is
// erased: the body is then emptied and the message leaves both threads.
// `side` is who wrote it: the reporter (the default, and every message stored
// before A25) or the team, in a reply written on that request's page (A25):
// a team message reaches that request's reporter only, never the team's
// `source: CLIENT` comments, and `authorId` is its author.
export const clientReportMessages = defineCollection({
  name: "clientReportMessages",
  schema: z.object({
    _id: id(),
    reportId: objectId(),
    side: z.enum(["reporter", "team"]).default("reporter"),
    authorId: accountId.nullable().default(null),
    body: z.string().max(MAX_MESSAGE),
    fileIds: z.array(objectId()).default([]),
    erasedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  indexes: [
    { key: { reportId: 1, _id: 1 }, name: "clientReportMessages_reportIdId" },
  ],
});
export type ClientReportMessageDocument = ReadDocumentOf<
  typeof clientReportMessages
>;

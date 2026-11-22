import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../core/shared/actors";

// A link between a request and an issue of the team (plan §20.4): a request
// may lead to several issues and an issue may serve several requests, so the
// pair lives here and `clientReports.issueId` only mirrors the first link
// (deprecated). The pair is unique. `linkedBy` is the account that made the
// link (the deciding account for a link the migration wrote).
export const clientReportLinks = defineCollection({
  name: "clientReportLinks",
  schema: z.object({
    _id: id(),
    reportId: objectId(),
    issueId: objectId(),
    linkedAt: z.date(),
    linkedBy: accountId,
  }),
  timestamps: true,
  actors,
  indexes: [
    {
      key: { reportId: 1, issueId: 1 },
      unique: true,
      name: "clientReportLinks_reportIssue",
    },
    { key: { issueId: 1 }, name: "clientReportLinks_issueId" },
  ],
});
export type ClientReportLinkDocument = ReadDocumentOf<typeof clientReportLinks>;

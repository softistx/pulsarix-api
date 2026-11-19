import type { ModuleMongo } from "../../config/db";
import type { ClientEntry, CommentSource } from "../comments/public";

type SourceMongo = ModuleMongo<"intake">;

// What a reporter wrote, as the team reads it on the issue: one read-only
// `source: CLIENT` entry per message, built here and never stored a second
// time (registered in module.ts). The messages of every report on the issue
// show, a linked duplicate's included; an erased one does not.
export const clientMessages: CommentSource = async (
  commentsMongo,
  { issueId, after, limit },
) => {
  const mongo = commentsMongo as unknown as SourceMongo;
  const reports = await mongo.db.clientReports.findMany({
    filter: { issueId },
    limit: 1_000,
  });
  if (reports.length === 0) return [];
  const byId = new Map(
    reports.map((report) => [report._id.toHexString(), report]),
  );
  const messages = await mongo.db.clientReportMessages.findMany({
    filter: {
      reportId: { $in: reports.map((report) => report._id) },
      erasedAt: null,
      ...(after && { _id: { $gt: after } }),
    },
    sort: { _id: 1 },
    limit,
  });
  return messages.map((message): ClientEntry => {
    const report = byId.get(message.reportId.toHexString());
    return {
      id: message.id,
      _id: message._id,
      issueId,
      authorId: null,
      body: message.body,
      mentionIds: [],
      public: false,
      editedAt: null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      source: "CLIENT",
      reportId: message.reportId.toHexString(),
      reporterName: report?.reporterName ?? null,
    };
  });
};

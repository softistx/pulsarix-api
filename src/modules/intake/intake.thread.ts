import { ObjectId } from "mongodb";
import { withoutMarkers } from "../comments/public";
import { reportNotFound } from "./intake.errors";
import type { IntakeMongo } from "./intake.submit";
import type { ClientReportDocument } from "./models";

// The reporter's side of a request (plan §19, A16): the thread of one report,
// its unread count and its read cursor. These are services, not endpoints: the
// public GraphQL operations that call them (A17) have authenticated the
// reporter and checked the rate limits first.

// Who may read and write a report's thread: the reporter an identity token
// vouched for, through the key the report came in by.
export interface Reporter {
  keyId: ObjectId;
  reporterKey: string;
}

// The reporter's own report, or the same 404 as an unknown one: a report of
// another reporter, of another key, an erased one, a malformed id.
export async function ownedReport(
  mongo: IntakeMongo,
  reporter: Reporter,
  reportId: string,
): Promise<ClientReportDocument> {
  const id = /^[0-9a-f]{24}$/.test(reportId) ? new ObjectId(reportId) : null;
  if (!id) throw reportNotFound();
  const report = await mongo.db.clientReports.findFirst({
    _id: id,
    widgetKeyId: reporter.keyId,
    reporterKey: reporter.reporterKey,
  });
  if (!report || report.erasedAt) throw reportNotFound();
  return report;
}

export interface ThreadFile {
  id: string;
  name: string;
  // A picture has a 256 px thumbnail the reporter may read.
  thumbnail: boolean;
}

export interface ThreadEntry {
  id: string;
  from: "reporter" | "team";
  body: string;
  at: Date;
  files: ThreadFile[];
}

export const MAX_THREAD = 200;

// The comments of the report's issue that belong to its thread: the team's
// public ones, from the report's link on when it was linked to an existing
// issue (it never sees what was said before). Internal comments never.
export const publicFilter = (
  report: ClientReportDocument,
  after?: Date | null,
) => {
  const from = [report.linkedAt, after].filter((date) => date != null);
  const since = from.length
    ? new Date(Math.max(...from.map((date) => date.getTime())))
    : null;
  return {
    issueId: report.issueId as ObjectId,
    public: true as const,
    ...(since && { createdAt: { $gt: since } }),
  };
};

// The thread, oldest first: the reporter's messages and the team's public
// comments, at most `MAX_THREAD` of the newest. An erased message is left out.
export async function readThread(
  mongo: IntakeMongo,
  report: ClientReportDocument,
): Promise<ThreadEntry[]> {
  const messages = await mongo.db.clientReportMessages.findMany({
    filter: { reportId: report._id, erasedAt: null },
    sort: { _id: -1 },
    limit: MAX_THREAD,
  });
  const files = messages.length
    ? await mongo.db.clientReportFiles.findMany({
        filter: {
          reportId: report._id,
          role: "reply",
          state: { $in: ["quarantined", "released"] },
          messageId: { $in: messages.map((message) => message._id) },
        },
        sort: { _id: 1 },
      })
    : [];
  const replies = report.issueId
    ? await mongo.db.comments.findMany({
        filter: publicFilter(report),
        sort: { _id: -1 },
        limit: MAX_THREAD,
      })
    : [];
  const entries: Array<ThreadEntry & { order: string }> = [
    ...messages.map((message) => ({
      order: message.id,
      id: message.id,
      from: "reporter" as const,
      body: message.body,
      at: message.createdAt,
      files: files
        .filter((file) => file.messageId?.equals(message._id))
        .map((file) => ({
          id: file.id,
          name: file.fileName,
          thumbnail:
            file.previewKey !== null && file.mime !== "application/pdf",
        })),
    })),
    ...replies.map((reply) => ({
      order: reply.id,
      id: reply.id,
      from: "team" as const,
      body: withoutMarkers(reply.body),
      at: reply.createdAt,
      files: [],
    })),
  ];
  return entries
    .sort((a, b) => a.order.localeCompare(b.order))
    .slice(-MAX_THREAD)
    .map(({ order: _order, ...entry }) => entry);
}

// The team's public replies the reporter has not read: those after their read
// cursor (and after the link, for a linked report).
export async function unreadCount(
  mongo: IntakeMongo,
  report: ClientReportDocument,
): Promise<number> {
  if (!report.issueId) return 0;
  return mongo.db.comments.count(publicFilter(report, report.reporterReadAt));
}

// The same for several reports at once, keyed by report id.
export async function unreadCounts(
  mongo: IntakeMongo,
  reports: readonly ClientReportDocument[],
): Promise<Map<string, number>> {
  const counts = await Promise.all(
    reports.map((report) => unreadCount(mongo, report)),
  );
  return new Map(reports.map((report, i) => [report.id, counts[i] ?? 0]));
}

// The reporter read their thread up to now (never backwards).
export async function markRead(
  mongo: IntakeMongo,
  report: ClientReportDocument,
  now: Date,
): Promise<void> {
  if (report.reporterReadAt && report.reporterReadAt >= now) return;
  await mongo.db.clientReports.update(report._id, { reporterReadAt: now });
}

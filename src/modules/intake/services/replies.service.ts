import type { ClientReportDocument } from "../models";
import { publicCommentsFilter } from "../utils/replies.utils";
import { linksOf } from "./linked-reports.service";
import type { IntakeMongo } from "./submit.service";

// What the team said to a reporter on a request (A25): the public comments of
// every issue it is linked to, from each link's date on, and the replies
// written on the request's own page (`side: "team"`).

export interface PublicReply {
  id: string;
  body: string;
  createdAt: Date;
  // The team member who wrote it, and the issue a comment is on (null for a
  // reply written on the request's page).
  authorId: string | null;
  issueId: string | null;
}

// The public comments of the request's issues, in `_id` order (`newest` reads
// from the end), at most `limit`.
export async function publicCommentsOf(
  mongo: IntakeMongo,
  report: ClientReportDocument,
  options: { after?: Date | null; newest?: boolean; limit: number },
): Promise<PublicReply[]> {
  const links = (await linksOf(mongo, [report])).get(report.id) ?? [];
  const filter = publicCommentsFilter(links, options.after);
  if (!filter) return [];
  const comments = await mongo.db.comments.findMany({
    filter,
    sort: { _id: options.newest ? -1 : 1 },
    limit: options.limit,
  });
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
    authorId: comment.authorId,
    issueId: comment.issueId.toHexString(),
  }));
}

// The replies, oldest first: comments and team messages together. `newest`
// keeps the newest `limit`, else the oldest ones after `after`.
export async function repliesOf(
  mongo: IntakeMongo,
  report: ClientReportDocument,
  options: { after?: Date | null; newest?: boolean; limit: number },
): Promise<PublicReply[]> {
  const sort = { _id: options.newest ? -1 : 1 } as const;
  const [comments, messages] = await Promise.all([
    publicCommentsOf(mongo, report, options),
    mongo.db.clientReportMessages.findMany({
      filter: {
        reportId: report._id,
        side: "team",
        erasedAt: null,
        ...(options.after && { createdAt: { $gt: options.after } }),
      },
      sort,
      limit: options.limit,
    }),
  ]);
  const all = [
    ...comments,
    ...messages.map((message) => ({
      id: message.id,
      body: message.body,
      createdAt: message.createdAt,
      authorId: message.authorId,
      issueId: null,
    })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return options.newest
    ? all.slice(-options.limit)
    : all.slice(0, options.limit);
}

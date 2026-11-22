import type { ModuleMongo } from "../../../config/db";
import { runAfterCommit } from "../../../core/shared/after-commit";
import { exhausted } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { retryWriteConflicts } from "../../../core/shared/locked";
import { withoutMarkers } from "../../comments/public";
import { reportNotFound, requestDeclined } from "../intake.errors";
import { announceChanged, announceRequests, requestsOf } from "../intake.live";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument, ClientReportFileDocument } from "../models";
import { messageBody } from "./messages.service";
import { scheduleReporterMails } from "./notify.service";
import { publicCommentsOf } from "./replies.service";
import { MAX_THREAD } from "./thread.service";
import { refreshLinkedIssuesWaiting } from "./waiting.service";

// What the team reads of a request's thread, and writes to its reporter (A25).

export type TeamThreadSource = "REPORTER" | "TEAM_REPLY" | "ISSUE_COMMENT";

export interface TeamThreadEntry {
  id: string;
  source: TeamThreadSource;
  body: string;
  at: Date;
  authorId: string | null;
  issueId: string | null;
  files: ClientReportFileDocument[];
}

// The request as the team sees it, or the same 404 as an unknown one.
export async function requestById(
  mongo: IntakeMongo,
  id: string,
): Promise<ClientReportDocument> {
  const report = await mongo.db.clientReports.findById(idOrInvalid(id, "id"));
  if (!report || report.erasedAt) throw reportNotFound();
  return report;
}

// The thread, oldest first, each entry with its source: the reporter's
// messages (and their files), the team's replies written on the request's
// page and the public comments of every issue it is linked to. Internal
// comments never. An erased message is left out; at most `MAX_THREAD`, the
// newest.
export async function teamThread(
  mongo: IntakeMongo,
  report: ClientReportDocument,
): Promise<TeamThreadEntry[]> {
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
  const comments = await publicCommentsOf(mongo, report, {
    newest: true,
    limit: MAX_THREAD,
  });
  const entries: TeamThreadEntry[] = [
    ...messages.map((message) => ({
      id: message.id,
      source:
        message.side === "team"
          ? ("TEAM_REPLY" as const)
          : ("REPORTER" as const),
      body: message.body,
      at: message.createdAt,
      authorId: message.authorId,
      issueId: null,
      files: files.filter((file) => file.messageId?.equals(message._id)),
    })),
    ...comments.map((comment) => ({
      id: comment.id,
      source: "ISSUE_COMMENT" as const,
      body: withoutMarkers(comment.body),
      at: comment.createdAt,
      authorId: comment.authorId,
      issueId: comment.issueId,
      files: [],
    })),
  ];
  return entries.sort((a, b) => a.id.localeCompare(b.id)).slice(-MAX_THREAD);
}

type ReplyMongo = IntakeMongo & ModuleMongo<"issues">;

// The team answers one request (and only that one): the reply is shown to its
// reporter in their thread and e-mailed like a public reply, and the request no
// longer waits on the team. A public comment on an issue still reaches every
// request linked to it; this reply does not.
export async function replyToClientRequest(
  mongo: ReplyMongo,
  who: { viewerId: string; organisationId: string },
  id: string,
  given: string,
): Promise<ClientReportDocument> {
  const body = messageBody(given);
  const found = await requestById(mongo, id);
  if (found.erasedAt) throw reportNotFound();
  if (found.state === "declined") throw requestDeclined();
  const report = await retryWriteConflicts(
    () =>
      mongo.transaction(async (tx) => {
        const current = await tx.db.clientReports.findById(found._id);
        if (!current || current.erasedAt) throw reportNotFound();
        if (current.state === "declined") throw requestDeclined();
        await tx.db.clientReportMessages.create({
          reportId: current._id,
          side: "team",
          authorId: who.viewerId,
          body,
          fileIds: [],
          erasedAt: null,
        });
        const answered = current.clientWaiting
          ? ((await tx.db.clientReports.update(current._id, {
              clientWaiting: false,
            })) ?? current)
          : current;
        await refreshLinkedIssuesWaiting(tx, answered);
        return answered;
      }),
    exhausted,
  );
  await runAfterCommit([
    announceChanged(who.organisationId, [report]),
    announceRequests(requestsOf(who.organisationId, [report], "state")),
    scheduleReporterMails(who.organisationId, [report]),
  ]);
  return report;
}

import type { ObjectId } from "mongodb";
import type { PublicState } from "../../projects/public";
import type { ClientReportDocument } from "../models";
import { combineMapped } from "../rules/client-state.rules";
import { timesOf } from "../utils/times.utils";
import { linkedIssueIds, linksOf } from "./linked-reports.service";
import { derivePublicState, mappedStatesOf } from "./public-state.service";
import type { IntakeMongo } from "./submit.service";

// The public state and the unread count of many reports at once (plan §19):
// the lists of "My requests" and the live stream read them for a whole
// reporter, so they are batched (one read of the issues, one of the statuses,
// one of the public comments) instead of asked report by report.

export async function publicStatesOf(
  mongo: IntakeMongo,
  reports: readonly ClientReportDocument[],
): Promise<Map<string, PublicState>> {
  const linked = await linkedIssueIds(mongo, reports);
  const mapped = await mappedStatesOf(mongo, [...linked.values()].flat());
  return new Map(
    reports.map((report) => [
      report.id,
      derivePublicState(
        report,
        combineMapped(
          (linked.get(report.id) ?? []).map(
            (id) => mapped.get(id.toHexString()) ?? null,
          ),
        ),
      ),
    ]),
  );
}

// The team's replies each report has not read: public comments of every issue
// it is linked to after its read cursor (and after the link), and the replies
// written on its page after the cursor. Counted in memory from one read of the
// comments' dates and one of the replies'.
export async function unreadOf(
  mongo: IntakeMongo,
  reports: readonly ClientReportDocument[],
): Promise<Map<string, number>> {
  const counts = new Map(reports.map((report) => [report.id, 0]));
  if (reports.length === 0) return counts;
  const links = await linksOf(mongo, reports);
  const issueIds: ObjectId[] = [...links.values()].flatMap((own) =>
    own.map((link) => link.issueId),
  );
  const [commentTimes, replyTimes] = await Promise.all([
    timesOf(
      mongo.db.comments.raw,
      { issueId: { $in: issueIds }, public: true },
      "$issueId",
    ),
    timesOf(
      mongo.db.clientReportMessages.raw,
      {
        reportId: { $in: reports.map((report) => report._id) },
        side: "team",
        erasedAt: null,
      },
      "$reportId",
    ),
  ]);
  for (const report of reports) {
    const read = report.reporterReadAt?.getTime() ?? 0;
    const after = (times: Date[] | undefined, from: number) =>
      (times ?? []).filter((at) => at.getTime() > from).length;
    const comments = (links.get(report.id) ?? []).reduce(
      (sum, link) =>
        sum +
        after(
          commentTimes.get(link.issueId.toHexString()),
          Math.max(link.since?.getTime() ?? 0, read),
        ),
      0,
    );
    counts.set(report.id, comments + after(replyTimes.get(report.id), read));
  }
  return counts;
}

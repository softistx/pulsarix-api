import { invalid } from "../../core/shared/errors";
import type { PublicState } from "../projects/public";
import {
  type RequestSummary,
  reportsOf,
  summaryOf,
} from "./intake.requests.read";
import type { Session } from "./intake.requests.session";
import { publicStatesOf, unreadOf } from "./intake.requests.state";
import type { ClientReportDocument } from "./models";

// What the reporter reads: the list of their requests, a page at a time.
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

export type RequestFilter = "OPEN" | "RESOLVED" | "DECLINED" | "ALL";

const matches = (filter: RequestFilter, state: PublicState) =>
  filter === "ALL" ||
  (filter === "OPEN" && (state === "received" || state === "inProgress")) ||
  (filter === "RESOLVED" && state === "resolved") ||
  (filter === "DECLINED" && state === "declined");

export interface MyRequests {
  nodes: RequestSummary[];
  counts: { open: number; resolved: number; declined: number; all: number };
  // The team's public replies the reporter has not read, over every request.
  unread: number;
  emailsOn: boolean;
  endCursor: string | null;
  hasNextPage: boolean;
}

// A page cursor: the group the request was in (u unread, r read) and its id.
// A bare id (an older cursor) is read in the group the request has now.
const cursorOf = (id: string, unread: boolean) => `${unread ? "u" : "r"}:${id}`;

function cursorKey(
  after: string | null | undefined,
  position: ReadonlyMap<string, number>,
  size: number,
  unreadNow: (id: string) => boolean,
): { id: string | null; key: number } {
  if (!after) return { id: null, key: -1 };
  const match = /^([ur]):(.+)$/.exec(after);
  const id = match?.[2] ?? after;
  const index = position.get(id);
  if (index === undefined) {
    throw invalid([{ path: "after", code: "validation.errors.invalid" }]);
  }
  const read = match ? match[1] === "r" : !unreadNow(id);
  return { id, key: (read ? size : 0) + index };
}

// The reporter's requests: unread ones first, then newest first, each page
// starting after the request `after`; the counts are over all of them.
export async function myRequests(
  session: Session,
  args: {
    filter?: RequestFilter | null;
    first?: number | null;
    after?: string | null;
  },
): Promise<MyRequests> {
  const first = args.first ?? DEFAULT_PAGE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE) {
    throw invalid([{ path: "first", code: "validation.errors.out-of-range" }]);
  }
  const reports = await reportsOf(session);
  const [states, unread] = await Promise.all([
    publicStatesOf(session.mongo, reports),
    unreadOf(session.mongo, reports),
  ]);
  const stateOf = (report: ClientReportDocument) =>
    states.get(report.id) ?? "received";
  const counts = { open: 0, resolved: 0, declined: 0, all: reports.length };
  for (const report of reports) {
    const state = stateOf(report);
    if (state === "resolved") counts.resolved += 1;
    else if (state === "declined") counts.declined += 1;
    else counts.open += 1;
  }
  const wanted = reports.filter((report) =>
    matches(args.filter ?? "OPEN", stateOf(report)),
  );
  const isUnread = (report: ClientReportDocument) =>
    (unread.get(report.id) ?? 0) > 0;
  const position = new Map(reports.map((report, index) => [report.id, index]));
  // Unread first, then the list's own order. A page ends at the position its
  // last request had, kept in the cursor with its group: a request that is
  // read (or gets a reply) between two pages moves group, and the cursor
  // still points where it was. Such a request may show a second time, in the
  // read group, but is never skipped: kept as it is (a stateless cursor; a
  // repeat is harmless, a gap would hide a request).
  const keyOf = (report: ClientReportDocument) =>
    (isUnread(report) ? 0 : reports.length) + (position.get(report.id) ?? 0);
  const ordered = wanted.toSorted((a, b) => keyOf(a) - keyOf(b));
  const from = cursorKey(
    args.after,
    position,
    reports.length,
    (id) => (unread.get(id) ?? 0) > 0,
  );
  const rest = ordered.filter(
    (report) => keyOf(report) > from.key && report.id !== from.id,
  );
  const page = rest.slice(0, first);
  const last = page.at(-1);
  const hasNextPage = rest.length > first;
  return {
    nodes: page.map((report) =>
      summaryOf(report, stateOf(report), unread.get(report.id) ?? 0),
    ),
    counts,
    unread: [...unread.values()].reduce((sum, n) => sum + n, 0),
    emailsOn: !reports.some((report) => report.emailsOff === true),
    endCursor: hasNextPage && last ? cursorOf(last.id, isUnread(last)) : null,
    hasNextPage,
  };
}

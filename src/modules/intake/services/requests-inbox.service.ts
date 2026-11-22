import type { ObjectId } from "mongodb";
import { invalid } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { projectNotFound } from "../../projects/public";
import type { IntakeMongo, ReportPage } from "../intake.types";
import type { ReportState } from "../models";
import {
  cursorOf,
  FIRST_GROUP,
  type InboxFilter,
  inboxFilter,
  parseCursor,
  SECOND_GROUP,
} from "../utils/inbox.utils";
import { MAX_PAGE } from "./reports.service";

// The team's inbox over the whole organisation (A25): every request of every
// project, or of one, for those who triage (the resolver's guard). Requests a
// reporter waits on and new ones come first, then the others, each group
// newest first.

export interface InboxArgs {
  projectId?: string | null | undefined;
  filter?: InboxFilter | null | undefined;
  // The former single-state argument, kept beside the filter.
  state?: ReportState | null | undefined;
  first?: number | null | undefined;
  after?: string | null | undefined;
}

async function projectOf(
  mongo: IntakeMongo,
  projectId: string | null | undefined,
): Promise<ObjectId | null> {
  if (!projectId) return null;
  const id = idOrInvalid(projectId, "projectId");
  if (!(await mongo.db.projects.exists({ _id: id }))) throw projectNotFound();
  return id;
}

export async function listRequests(
  mongo: IntakeMongo,
  args: InboxArgs,
): Promise<ReportPage> {
  const limit = args.first ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw invalid([{ path: "first", code: "validation.errors.out-of-range" }]);
  }
  const project = await projectOf(mongo, args.projectId);
  const cursor = parseCursor(args.after);
  const states = [
    ...(args.filter?.states ?? []),
    ...(args.state ? [args.state] : []),
  ];
  const narrow = inboxFilter(project, { ...args.filter, states });
  const read = (group: object, before: ObjectId | null, size: number) =>
    mongo.db.clientReports.findMany({
      filter: {
        $and: [...narrow, group, ...(before ? [{ _id: { $lt: before } }] : [])],
      },
      sort: { _id: -1 },
      limit: size,
    });
  const first =
    cursor.group === "a" ? await read(FIRST_GROUP, cursor.id, limit + 1) : [];
  const second =
    first.length > limit
      ? []
      : await read(
          SECOND_GROUP,
          cursor.group === "b" ? cursor.id : null,
          limit + 1 - first.length,
        );
  const found = [...first, ...second];
  const nodes = found.slice(0, limit);
  const last = nodes.at(-1);
  const hasNextPage = found.length > limit;
  return {
    nodes,
    endCursor: hasNextPage && last ? cursorOf(last) : null,
    hasNextPage,
  };
}

export interface RequestCounts {
  new: number;
  accepted: number;
  declined: number;
  closed: number;
  clientWaiting: number;
  total: number;
}

// How many requests are in each state, over the organisation or one project,
// and how many of them a reporter is waiting on.
export async function countRequests(
  mongo: IntakeMongo,
  projectId: string | null | undefined,
): Promise<RequestCounts> {
  const project = await projectOf(mongo, projectId);
  const match = project
    ? { projectId: project, erasedAt: null }
    : { erasedAt: null };
  const rows = (await mongo.db.clientReports.raw
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: "$state",
          count: { $sum: 1 },
          waiting: {
            $sum: { $cond: [{ $eq: ["$clientWaiting", true] }, 1, 0] },
          },
        },
      },
    ])
    .toArray()) as Array<{ _id: ReportState; count: number; waiting: number }>;
  const counts: RequestCounts = {
    new: 0,
    accepted: 0,
    declined: 0,
    closed: 0,
    clientWaiting: 0,
    total: 0,
  };
  for (const row of rows) {
    counts[row._id] = row.count;
    counts.clientWaiting += row.waiting;
    counts.total += row.count;
  }
  return counts;
}

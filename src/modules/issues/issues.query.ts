import { InvalidCursorError, toObjectId } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { escapeRegex } from "../../core/shared/regex";
import type { IssueDocument, IssueType, Priority } from "./issues.model";
import { activeSprintOf } from "./issues.registry";
import type { IssuesMongo } from "./issues.types";

export interface IssueFilter {
  statusIds?: string[] | null;
  categories?: string[] | null;
  priorities?: Priority[] | null;
  types?: IssueType[] | null;
  assigneeId?: string | null;
  unassigned?: boolean | null;
  labelIds?: string[] | null;
  parentId?: string | null;
  rootsOnly?: boolean | null;
  noEpic?: boolean | null;
  reporterId?: string | null;
  watching?: boolean | null;
  clientWaiting?: boolean | null;
  sprintId?: string | null;
  backlog?: boolean | null;
  activeSprint?: boolean | null;
  text?: string | null;
  startAfter?: Date | null;
  startBefore?: Date | null;
  dueAfter?: Date | null;
  dueBefore?: Date | null;
}

export type IssueSortField =
  | "rank"
  | "planRank"
  | "number"
  | "title"
  | "priority"
  | "points"
  | "dueDate"
  | "startDate"
  | "createdAt"
  | "updatedAt";

export interface IssueSort {
  field: IssueSortField;
  direction: "asc" | "desc";
}

// The stored field a sort field orders by (a priority orders by its weight).
const orderBy = {
  rank: "rank",
  planRank: "planRank",
  number: "number",
  title: "title",
  priority: "priorityLevel",
  points: "points",
  dueDate: "dueDate",
  startDate: "startDate",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
} as const;

export interface IssuePage {
  nodes: IssueDocument[];
  endCursor: string | null;
  hasNextPage: boolean;
}

const MAX_PAGE = 100;

const ids = (given: string[], path: string): ObjectId[] =>
  given.map((id) => idOrInvalid(id, path));

// An issue stored before the types has none: it is a task (`null` matches it).
const typesIn = (types: IssueType[]): (IssueType | null)[] =>
  types.includes("task") ? [...types, null] : types;

// The "No Epic" row of the roadmap: Stories, Tasks and Bugs with no parent.
export const noEpicTypes = typesIn(["story", "task", "bug"]);

// The `type` and `parentId` clauses: `types` (narrowed to the No Epic types
// by `noEpic`), `parentId`, `rootsOnly` and `noEpic` (no parent).
const shapeOf = (f: IssueFilter) => {
  const types = f.types && f.types.length > 0 ? typesIn(f.types) : null;
  const planable = f.noEpic || isBacklog(f);
  const wanted =
    planable && types
      ? types.filter((type) => noEpicTypes.includes(type))
      : planable
        ? noEpicTypes
        : types;
  return {
    ...(wanted && { type: { $in: wanted } }),
    ...(f.parentId
      ? { parentId: toObjectId(idOrInvalid(f.parentId, "parentId")) }
      : (f.rootsOnly || f.noEpic) && { parentId: null }),
  };
};

// The categories an issue not yet planned can still be in: the backlog leaves
// out what intake has not accepted and what is finished.
const planningCategories = ["backlog", "todo", "inProgress"];

// The backlog filter applies unless a sprint is named: Stories, Tasks and
// Bugs in no sprint, still open.
const isBacklog = (f: IssueFilter) =>
  Boolean(f.backlog) && !f.sprintId && !f.activeSprint;

// The `sprintId` clause: a sprint, the active one, or the backlog (Stories,
// Tasks and Bugs, a `type` of null being a legacy task, in no sprint).
// `sprintId` wins over `activeSprint`, which wins over `backlog`. A project with
// no active sprint has no issue in `activeSprint`.
async function sprintClause(
  mongo: IssuesMongo,
  projectId: ObjectId,
  f: IssueFilter,
): Promise<Record<string, unknown>> {
  if (f.sprintId) {
    return { sprintId: toObjectId(idOrInvalid(f.sprintId, "sprintId")) };
  }
  if (f.activeSprint) {
    const active = await activeSprintOf(mongo, projectId);
    return active ? { sprintId: active } : { _id: { $in: [] } };
  }
  return isBacklog(f) ? { sprintId: null } : {};
}

// The statuses the filter allows: its ids and categories, narrowed to the
// planning categories by `backlog`. Null is no restriction.
async function statusesOf(
  mongo: IssuesMongo,
  projectId: ObjectId,
  f: IssueFilter,
): Promise<ObjectId[] | null> {
  const statusIds = f.statusIds ? ids(f.statusIds, "statusIds") : null;
  const named = f.categories ?? [];
  const inBacklog = isBacklog(f);
  if (named.length === 0 && !inBacklog) return statusIds;
  const categories = !inBacklog
    ? named
    : named.length > 0
      ? named.filter((category) => planningCategories.includes(category))
      : planningCategories;
  const found = await mongo.db.statuses.findMany({
    filter: { projectId, category: { $in: categories as never } },
  });
  const wanted = found.map((status) => status._id);
  return statusIds
    ? statusIds.filter((id) => wanted.some((w) => w.equals(id)))
    : wanted;
}

const range = (from?: Date | null, to?: Date | null) =>
  from || to
    ? { ...(from && { $gte: from }), ...(to && { $lte: to }) }
    : undefined;

// The issues of a project, filtered, sorted and paged by cursor. Reading
// needs no lock.
export async function listIssues(
  mongo: IssuesMongo,
  viewerId: string,
  args: {
    projectId: string;
    filter?: IssueFilter | null;
    sort?: IssueSort | null;
    first?: number | null;
    after?: string | null;
  },
): Promise<IssuePage> {
  const projectId = idOrInvalid(args.projectId, "projectId");
  const f = args.filter ?? {};
  const limit = args.first ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw invalid([{ path: "first", code: "validation.errors.out-of-range" }]);
  }

  const statusIds = await statusesOf(mongo, projectId, f);
  const sprint = await sprintClause(mongo, projectId, f);
  const text = f.text?.trim();
  const due = range(f.dueAfter, f.dueBefore);
  const start = range(f.startAfter, f.startBefore);
  const filter = {
    projectId,
    ...(statusIds && { statusId: { $in: statusIds } }),
    ...(f.priorities && { priority: { $in: f.priorities } }),
    ...shapeOf(f),
    ...sprint,
    ...(f.assigneeId && { assigneeId: f.assigneeId }),
    ...(f.unassigned && !f.assigneeId && { assigneeId: null }),
    ...(f.labelIds &&
      f.labelIds.length > 0 && {
        labelIds: { $in: ids(f.labelIds, "labelIds") },
      }),
    ...(f.reporterId && { reporterId: f.reporterId }),
    ...(f.watching && { watcherIds: viewerId }),
    ...(f.clientWaiting && { clientWaiting: true }),
    ...(text && { title: { $regex: escapeRegex(text), $options: "i" } }),
    ...(due && { dueDate: due }),
    ...(start && { startDate: start }),
  };

  const sort = args.sort ?? { field: "number", direction: "asc" };
  try {
    const page = await mongo.db.issues.paginateByCursor({
      filter: filter as never,
      orderBy: orderBy[sort.field],
      direction: sort.direction,
      limit,
      after: args.after ?? null,
      scope: `${projectId.toHexString()}:${JSON.stringify([f, sort])}`,
    });
    return {
      nodes: page.items,
      endCursor: page.nextCursor,
      hasNextPage: page.nextCursor !== null,
    };
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw invalid([{ path: "after", code: "validation.errors.invalid" }]);
    }
    throw error;
  }
}

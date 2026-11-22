import { InvalidCursorError, toObjectId } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { escapeRegex } from "../../core/shared/regex";
import type { IssueDocument, IssueType, Priority } from "./issues.model";
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
  reporterId?: string | null;
  watching?: boolean | null;
  clientWaiting?: boolean | null;
  text?: string | null;
  startAfter?: Date | null;
  startBefore?: Date | null;
  dueAfter?: Date | null;
  dueBefore?: Date | null;
}

export type IssueSortField =
  | "rank"
  | "number"
  | "title"
  | "priority"
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
  number: "number",
  title: "title",
  priority: "priorityLevel",
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

  let statusIds = f.statusIds ? ids(f.statusIds, "statusIds") : null;
  if (f.categories && f.categories.length > 0) {
    const inCategories = await mongo.db.statuses.findMany({
      filter: {
        projectId,
        category: { $in: f.categories as never },
      },
    });
    const wanted = inCategories.map((status) => status._id);
    statusIds = statusIds
      ? statusIds.filter((id) => wanted.some((w) => w.equals(id)))
      : wanted;
  }
  const text = f.text?.trim();
  const due = range(f.dueAfter, f.dueBefore);
  const start = range(f.startAfter, f.startBefore);
  const filter = {
    projectId,
    ...(statusIds && { statusId: { $in: statusIds } }),
    ...(f.priorities && { priority: { $in: f.priorities } }),
    ...(f.types && f.types.length > 0 && { type: { $in: typesIn(f.types) } }),
    ...(f.assigneeId && { assigneeId: f.assigneeId }),
    ...(f.unassigned && !f.assigneeId && { assigneeId: null }),
    ...(f.labelIds &&
      f.labelIds.length > 0 && {
        labelIds: { $in: ids(f.labelIds, "labelIds") },
      }),
    ...(f.parentId && {
      parentId: toObjectId(idOrInvalid(f.parentId, "parentId")),
    }),
    ...(f.rootsOnly && !f.parentId && { parentId: null }),
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

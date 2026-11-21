import { ObjectId } from "mongodb";
import { invalid } from "../../core/shared/errors";
import type { ProjectDocument, StatusDocument } from "../projects/public";
import type { Base, FigureRow } from "./dashboard.types";

// 1 when the issue has a due date before `start` (the start of today), else 0.
// A missing or null date is never late.
export const lateOf = (start: Date) => ({
  $cond: [
    { $and: [{ $gt: ["$dueDate", null] }, { $lt: ["$dueDate", start] }] },
    1,
    0,
  ],
});

const count = (test: object) => ({ $sum: { $cond: [test, 1, 0] } });

// One pass over the open issues of the projects, per project. Everything it
// reads (project, status, priority, due date) is in the
// `issues_projectIdStatusIdPriorityDue` index, so no document is fetched.
export const figuresPipeline = (
  projectIds: ObjectId[],
  openIds: ObjectId[],
  triageIds: ObjectId[],
  start: Date,
) => [
  { $match: { projectId: { $in: projectIds }, statusId: { $in: openIds } } },
  {
    $group: {
      _id: "$projectId",
      open: { $sum: 1 },
      urgent: count({ $eq: ["$priorityLevel", 4] }),
      late: { $sum: lateOf(start) },
      triage: count({ $in: ["$statusId", triageIds] }),
    },
  },
];

// A position in the order (late, priority, updated, id) on one day: late
// changes at midnight, so a cursor of another day is no longer a position.
export type Cursor = [
  late: number,
  level: number,
  updated: number,
  id: string,
  day: string,
];

export const encode = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

export function decode(after: string, today: string): Cursor {
  const refused = () =>
    invalid([{ path: "after", code: "validation.errors.invalid" }]);
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(after, "base64url").toString());
  } catch {
    throw refused();
  }
  const [late, level, updated, id, day] = Array.isArray(cursor) ? cursor : [];
  if (
    !(late === 0 || late === 1) ||
    !Number.isSafeInteger(level) ||
    !Number.isSafeInteger(updated) ||
    typeof id !== "string" ||
    !/^[0-9a-f]{24}$/i.test(id) ||
    day !== today
  ) {
    throw refused();
  }
  return [late, level, updated, id, today];
}

// The documents strictly after the cursor in the sort order.
export const after = ([late, level, updated, id]: Cursor) => {
  const at = new Date(updated);
  return {
    $or: [
      { late: { $lt: late } },
      { late, priorityLevel: { $lt: level } },
      { late, priorityLevel: level, updatedAt: { $lt: at } },
      {
        late,
        priorityLevel: level,
        updatedAt: at,
        _id: { $lt: new ObjectId(id) },
      },
    ],
  };
};

// The projects by name.
export const byName = (projects: ProjectDocument[]) =>
  [...projects].sort((a, b) => a.name.localeCompare(b.name));

// The base of a dashboard from its projects and their statuses: the open
// statuses are the ones not done and not cancelled, the triage ones among them.
export function baseOf(
  projects: ProjectDocument[],
  list: StatusDocument[],
): Base {
  const open = list.filter(
    (s) => s.category !== "done" && s.category !== "cancelled",
  );
  return {
    projects,
    statuses: new Map(list.map((s) => [s.id, s])),
    openIds: open.map((s) => s._id),
    triageIds: open.filter((s) => s.category === "triage").map((s) => s._id),
  };
}

// The figure rows by project id.
export const rowsById = (rows: FigureRow[]) =>
  new Map(rows.map((row) => [row._id.toHexString(), row]));

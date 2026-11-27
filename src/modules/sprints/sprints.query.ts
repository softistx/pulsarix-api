import type { ObjectId } from "mongodb";

// The grouped read behind `Sprint.progress`: the issues of the given sprints
// with their status category, the cancelled ones left out, summed per sprint.
// Points count only on a `done` status for `pointsDone`; an unestimated issue
// counts for none.
export const progressPipeline = (sprintIds: readonly ObjectId[]) => [
  { $match: { sprintId: { $in: [...sprintIds] } } },
  {
    $lookup: {
      // Must match the collection name in projects.model.ts.
      from: "statuses",
      localField: "statusId",
      foreignField: "_id",
      as: "status",
    },
  },
  { $unwind: "$status" },
  { $match: { "status.category": { $ne: "cancelled" } } },
  {
    $group: {
      _id: "$sprintId",
      points: { $sum: { $ifNull: ["$points", 0] } },
      pointsDone: {
        $sum: {
          $cond: [
            { $eq: ["$status.category", "done"] },
            { $ifNull: ["$points", 0] },
            0,
          ],
        },
      },
      issues: { $sum: 1 },
      issuesDone: {
        $sum: { $cond: [{ $eq: ["$status.category", "done"] }, 1, 0] },
      },
    },
  },
];

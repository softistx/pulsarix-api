import type { ObjectId } from "mongodb";

// The rows of a `$group` of creation dates, keyed by hex id.
export const timesByHexId = (
  rows: readonly { _id: ObjectId; times: Date[] }[],
): Map<string, Date[]> =>
  new Map(rows.map((row) => [row._id.toHexString(), row.times]));

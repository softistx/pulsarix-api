import type { ObjectId } from "mongodb";

// The creation dates of the matching rows, grouped by `key` (hex id).
export async function timesOf(
  collection: {
    aggregate: (pipeline: object[]) => { toArray: () => Promise<unknown[]> };
  },
  match: object,
  key: string,
): Promise<Map<string, Date[]>> {
  const rows = (await collection
    .aggregate([
      { $match: match },
      { $group: { _id: key, times: { $push: "$createdAt" } } },
    ])
    .toArray()) as { _id: ObjectId; times: Date[] }[];
  return new Map(rows.map((row) => [row._id.toHexString(), row.times]));
}

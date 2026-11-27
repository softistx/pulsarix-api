import { toObjectId } from "@softistx/mongo";
import DataLoader from "dataloader";
import type { ObjectId } from "mongodb";
import type { SprintProgress } from "@/generated/graphql/resolvers";
import { progressPipeline } from "./sprints.query";
import type { SprintsMongo } from "./sprints.types";

const NONE: SprintProgress = {
  points: 0,
  pointsDone: 0,
  issues: 0,
  issuesDone: 0,
};

interface Row extends SprintProgress {
  _id: ObjectId;
}

// The live progress of sprints, per request: a list of sprints is one
// aggregation, not one read per sprint. Keys are sprint ids. `mongoOf` runs the
// read guard (once per batch). Not cached: a mutation can change the issues
// before its payload reads the field.
export function sprintsLoaders(mongoOf: () => Promise<SprintsMongo>) {
  return {
    progress: new DataLoader<string, SprintProgress>(
      async (ids) => {
        const mongo = await mongoOf();
        const rows = (await mongo.db.issues.raw
          .aggregate(progressPipeline(ids.map((id) => toObjectId(id))))
          .toArray()) as unknown as Row[];
        const byId = new Map(rows.map((row) => [row._id.toHexString(), row]));
        return ids.map((id) => {
          const row = byId.get(id);
          return row
            ? {
                points: row.points,
                pointsDone: row.pointsDone,
                issues: row.issues,
                issuesDone: row.issuesDone,
              }
            : { ...NONE };
        });
      },
      { cache: false },
    ),
  };
}

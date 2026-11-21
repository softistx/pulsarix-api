import { toObjectId } from "@softistx/mongo";
import DataLoader from "dataloader";
import { grouped } from "../../core/shared/ids";
import type { LabelDocument, StatusDocument } from "./projects.model";
import type { ProjectsMongo } from "./projects.usage";
import { LABELS_ORDER, STATUSES_ORDER } from "./projects.utils";

// A project's statuses and labels, per request: the projects of one page ask
// together, so a page is one read of each, not one per project. `mongoOf` runs
// the read guard (once per batch). Keys are project ids; each value keeps the
// order the services' `list` gives (statuses by `order`, labels by name).
export function projectsLoaders(mongoOf: () => Promise<ProjectsMongo>) {
  const projectIn = (ids: readonly string[]) => ({
    projectId: { $in: ids.map((id) => toObjectId(id)) },
  });
  return {
    statuses: new DataLoader<string, StatusDocument[]>(async (ids) => {
      const rows = await (await mongoOf()).db.statuses.findMany({
        filter: projectIn(ids),
        ...STATUSES_ORDER,
      });
      return grouped(ids, rows, (row) => row.projectId.toHexString());
    }),
    labels: new DataLoader<string, LabelDocument[]>(async (ids) => {
      const rows = await (await mongoOf()).db.labels.findMany({
        filter: projectIn(ids),
        ...LABELS_ORDER,
      });
      return grouped(ids, rows, (row) => row.projectId.toHexString());
    }),
  };
}

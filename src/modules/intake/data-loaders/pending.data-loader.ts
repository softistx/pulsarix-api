import DataLoader from "dataloader";
import { idOrInvalid } from "../../../core/shared/ids";
import type { IntakeMongo } from "../intake.types";
import { pendingCountsOf } from "../services/files-team.service";

// How many files of each report wait for their bytes, per request: keys are
// report ids, and the reports of one page of the inbox share one grouped read.
// `mongoOf` runs the inbox guard (once per batch).
export const pendingLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<string, number>(async (ids) => {
    const counts = await pendingCountsOf(
      await mongoOf(),
      ids.map((id) => idOrInvalid(id, "reportId")),
    );
    return ids.map((id) => counts.get(id) ?? 0);
  });

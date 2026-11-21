import DataLoader from "dataloader";
import { idOrInvalid } from "../../../core/shared/ids";
import type { IntakeMongo } from "../intake.types";
import { pendingCountsOf } from "../services";

// How many files of each report wait for their bytes, per request: keys are
// report ids, and the reports of one page of the inbox share one grouped read.
// `mongoOf` runs the inbox guard (once per batch).
// Not cached: files settle during a request (an upload completes, a report is
// released), so a later field of the same document reads the count the write
// left.
export const pendingLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<string, number>(
    async (ids) => {
      const counts = await pendingCountsOf(
        await mongoOf(),
        [...new Set(ids)].map((id) => idOrInvalid(id, "reportId")),
      );
      return ids.map((id) => counts.get(id) ?? 0);
    },
    { cache: false },
  );

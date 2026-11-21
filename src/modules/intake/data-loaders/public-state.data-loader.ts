import DataLoader from "dataloader";
import type { PublicState } from "../../projects/public";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument } from "../models";
import { publicStatesOf } from "../services/requests-state.service";

// The public state of each report, per request: the reports resolved in the
// same tick (one per report of a list) share one read of the issues and one of
// the statuses. Keyed by the report itself, cached by its id. `mongoOf` runs
// the inbox guard (once per batch).
export const publicStateLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<ClientReportDocument, PublicState, string>(
    async (reports) => {
      const states = await publicStatesOf(await mongoOf(), reports);
      return reports.map((report) => states.get(report.id) ?? "received");
    },
    { cacheKeyFn: (report) => report.id },
  );

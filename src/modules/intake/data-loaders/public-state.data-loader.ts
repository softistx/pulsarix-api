import DataLoader from "dataloader";
import type { PublicState } from "../../projects/public";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument } from "../models";
import { publicStatesOf } from "../services";

// The public state of each report, per request: the reports resolved in the
// same tick (one per report of a list) share one read of the issues and one of
// the statuses. Keyed by the report itself and not cached: acceptClientReport,
// declineClientReport and linkClientReport each return the report, so a
// document that runs two of them must read the state the first one left, not
// the one memoised before it. `mongoOf` runs the inbox guard (once per batch).
export const publicStateLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<ClientReportDocument, PublicState, string>(
    async (reports) => {
      const states = await publicStatesOf(await mongoOf(), reports);
      return reports.map((report) => states.get(report.id) ?? "received");
    },
    { cache: false },
  );

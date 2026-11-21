import DataLoader from "dataloader";
import { grouped, idOrInvalid } from "../../core/shared/ids";
import { filesOfReports } from "./intake.files.team";
import type { ClientReportFileDocument } from "./intake.model";
import type { IntakeMongo } from "./intake.reports";

// The files of the reports of one page of the inbox, per request: keys are
// report ids. `mongoOf` runs the inbox guard (once per batch).
export function intakeLoaders(mongoOf: () => Promise<IntakeMongo>) {
  return {
    files: new DataLoader<string, ClientReportFileDocument[]>(async (ids) => {
      const rows = await filesOfReports(
        await mongoOf(),
        ids.map((id) => idOrInvalid(id, "reportId")),
      );
      return grouped(ids, rows, (row) => row.reportId.toHexString());
    }),
  };
}

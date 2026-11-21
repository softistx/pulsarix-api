import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import type { Media } from "../../attachments/public";
import { fileObjectKeys, removeObjects } from "./files-storage.service";

type FilesMongo = ModuleMongo<"intake">;

export type SweptCounter = "pending" | "declined" | "untriaged" | "deleted";

// What a purge run carries: the organisation's database and bucket, the page
// size and the tally the sweeps add to.
export interface SweepRun {
  mongo: FilesMongo;
  media: Media;
  organisationId: string;
  page: number;
  purged: Record<SweptCounter | "failed", number>;
}

// Removes the files matching the filter, page by page by _id so a file whose
// objects cannot be removed (it stays) never blocks the ones behind it.
export async function sweepFiles(
  run: SweepRun,
  filter: Record<string, unknown>,
  counter: SweptCounter,
): Promise<void> {
  const files = run.mongo.db.clientReportFiles;
  let after: ObjectId | undefined;
  for (;;) {
    const found = (await files.raw
      .find(after ? { ...filter, _id: { $gt: after } } : filter)
      .sort({ _id: 1 })
      .limit(run.page)
      .toArray()) as Array<{ _id: ObjectId; storageKey?: string | null }>;
    if (found.length === 0) return;
    for (const file of found) {
      const failed = file.storageKey
        ? await removeObjects(
            run.media,
            fileObjectKeys(run.organisationId, file.storageKey),
          )
        : 0;
      run.purged.failed += failed;
      if (failed === 0) {
        await files.hardDelete(file._id);
        run.purged[counter] += 1;
      }
    }
    after = found[found.length - 1]?._id;
  }
}

// The files of the reports past their date. It starts from the files side
// (the distinct `reportId` of the quarantined files, read through the `state`
// index as `releaseStranded` does), then reads only those reports by `_id`: a
// report whose files are gone is never walked again, and no query of
// `clientReports` depends on `state` with a date. A report holding only
// pending slots is left to the pending purge.
export async function sweepReportFiles(
  run: SweepRun,
  reportFilter: Record<string, unknown>,
  counter: "declined" | "untriaged",
): Promise<void> {
  const held = (await run.mongo.db.clientReportFiles.raw.distinct("reportId", {
    state: "quarantined",
  })) as ObjectId[];
  for (let from = 0; from < held.length; from += run.page) {
    const due = (await run.mongo.db.clientReports.raw
      .find(
        { ...reportFilter, _id: { $in: held.slice(from, from + run.page) } },
        { projection: { _id: 1 } },
      )
      .toArray()) as Array<{ _id: ObjectId }>;
    if (due.length > 0) {
      await sweepFiles(
        run,
        { reportId: { $in: due.map((r) => r._id) } },
        counter,
      );
    }
  }
}

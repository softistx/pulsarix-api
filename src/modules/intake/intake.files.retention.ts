import type { ObjectId } from "mongodb";
import type { AppTenancy, ModuleMongo } from "../../config/db";
import type { Media } from "../attachments/public";
import { fileObjectKeys, removeObjects } from "./intake.files.storage";
import { releaseStranded } from "./intake.files.team";

// How long a report's files stay (plan Q15 and the widget v2 decisions): a
// declined report's for 7 days from the decision, a report nobody triaged for
// 90 days from its arrival, a pending slot for the 15 minutes its ticket lives.
// An accepted report's files stay with its issue.
export const DECLINED_FILES_DAYS = 7;
export const UNTRIAGED_FILES_DAYS = 90;
export const PENDING_SLOT_MINUTES = 15;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 500;

type FilesMongo = ModuleMongo<"intake">;

export interface FilesPurged {
  pending: number;
  declined: number;
  untriaged: number;
  // The files of a deleted issue.
  deleted: number;
  // Reports whose quarantined files were released (a release that had failed).
  released: number;
  // Objects that could not be removed (the records are gone: the next sweep
  // of the organisation's prefix finds them).
  failed: number;
}

// Removes, in one organisation, the records and the bucket objects of the
// files whose time is up. Objects first, then the records: a record whose
// objects could not be removed stays, so the next run tries again. Safe to
// repeat. The reports themselves are not touched.
export async function purgeReportFiles(
  mongo: FilesMongo,
  media: Media,
  organisationId: string,
  now = new Date(),
  PAGE = PAGE_SIZE,
): Promise<FilesPurged> {
  const files = mongo.db.clientReportFiles;
  const purged: FilesPurged = {
    pending: 0,
    declined: 0,
    untriaged: 0,
    deleted: 0,
    released: 0,
    failed: 0,
  };
  // Removes the files matching the filter, page by page by _id so a file whose
  // objects cannot be removed (it stays) never blocks the ones behind it.
  const sweep = async (
    filter: Record<string, unknown>,
    counter: "pending" | "declined" | "untriaged" | "deleted",
  ) => {
    let after: ObjectId | undefined;
    for (;;) {
      const found = (await files.raw
        .find(after ? { ...filter, _id: { $gt: after } } : filter)
        .sort({ _id: 1 })
        .limit(PAGE)
        .toArray()) as Array<{ _id: ObjectId; storageKey?: string | null }>;
      if (found.length === 0) return;
      for (const file of found) {
        const failed = file.storageKey
          ? await removeObjects(
              media,
              fileObjectKeys(organisationId, file.storageKey),
            )
          : 0;
        purged.failed += failed;
        if (failed === 0) {
          await files.hardDelete(file._id);
          purged[counter] += 1;
        }
      }
      after = found[found.length - 1]?._id;
    }
  };
  // The reports past their date, page by page, then their files.
  const sweepReports = async (
    reportFilter: Record<string, unknown>,
    counter: "declined" | "untriaged",
  ) => {
    let after: ObjectId | undefined;
    for (;;) {
      const page = (await mongo.db.clientReports.raw
        .find(after ? { ...reportFilter, _id: { $gt: after } } : reportFilter, {
          projection: { _id: 1 },
        })
        .sort({ _id: 1 })
        .limit(PAGE)
        .toArray()) as Array<{ _id: ObjectId }>;
      if (page.length === 0) return;
      await sweep({ reportId: { $in: page.map((r) => r._id) } }, counter);
      after = page[page.length - 1]?._id;
    }
  };
  // A pending slot is purged once its ticket expired, or, with no expiry
  // recorded, once it is older than the ticket's life.
  await sweep(
    {
      state: "pending",
      $or: [
        { expiresAt: { $lte: now } },
        {
          expiresAt: null,
          createdAt: {
            $lte: new Date(now.getTime() - PENDING_SLOT_MINUTES * 60_000),
          },
        },
      ],
    },
    "pending",
  );
  // The files of a deleted issue: marked with a removal date by the issue's
  // deletion (intake.closing.ts), removed with their objects once it passes.
  await sweep(
    {
      state: { $in: ["released", "quarantined"] },
      expiresAt: { $ne: null, $lte: now },
    },
    "deleted",
  );
  purged.released = await releaseStranded(mongo);
  await sweepReports(
    {
      state: "declined",
      decidedAt: {
        $lte: new Date(now.getTime() - DECLINED_FILES_DAYS * DAY_MS),
      },
    },
    "declined",
  );
  await sweepReports(
    {
      state: "new",
      createdAt: {
        $lte: new Date(now.getTime() - UNTRIAGED_FILES_DAYS * DAY_MS),
      },
    },
    "untriaged",
  );
  return purged;
}

// The job over every active organisation. One failing does not stop the
// others; the job fails afterwards so the queue retries it.
export async function purgeAllReportFiles(
  tenancy: Pick<AppTenancy, "eachTenant">,
  media: Media,
  now = new Date(),
  log: (message: string, error?: unknown) => void = console.warn,
): Promise<number> {
  const results = await tenancy.eachTenant(
    async (tenant, mongo) =>
      purgeReportFiles(
        mongo as unknown as FilesMongo,
        media,
        tenant._id.toHexString(),
        now,
      ),
    { onError: "collect" },
  );
  let removed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      removed +=
        result.value.pending +
        result.value.declined +
        result.value.untriaged +
        result.value.deleted;
      if (result.value.failed > 0) failed += 1;
    } else {
      failed += 1;
      log("report files retention failed for an organisation", result.error);
    }
  }
  if (failed > 0) {
    throw new Error(
      `report files retention failed for ${failed} organisation(s)`,
    );
  }
  return removed;
}

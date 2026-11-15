import type { AppTenancy, ModuleMongo } from "../../config/db";
import type { Media } from "../attachments/public";
import { fileObjectKeys, removeObjects } from "./intake.files.storage";

// How long a report's files stay (plan Q15 and the widget v2 decisions): a
// declined report's for 7 days from the decision, a report nobody triaged for
// 90 days from its arrival, a pending slot for the 15 minutes its ticket lives.
// An accepted report's files stay with its issue.
export const DECLINED_FILES_DAYS = 7;
export const UNTRIAGED_FILES_DAYS = 90;
export const PENDING_SLOT_MINUTES = 15;
const DAY_MS = 86_400_000;

type FilesMongo = ModuleMongo<"intake">;

export interface FilesPurged {
  pending: number;
  declined: number;
  untriaged: number;
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
): Promise<FilesPurged> {
  const files = mongo.db.clientReportFiles;
  const reports = mongo.db.clientReports;
  const declined = await reports.findMany({
    filter: {
      state: "declined",
      decidedAt: {
        $lte: new Date(now.getTime() - DECLINED_FILES_DAYS * DAY_MS),
      },
    },
    limit: 1_000,
  });
  const untriaged = await reports.findMany({
    filter: {
      state: "new",
      createdAt: {
        $lte: new Date(now.getTime() - UNTRIAGED_FILES_DAYS * DAY_MS),
      },
    },
    limit: 1_000,
  });
  const purged: FilesPurged = {
    pending: 0,
    declined: 0,
    untriaged: 0,
    failed: 0,
  };
  const sweep = async (
    filter: Record<string, unknown>,
    counter: "pending" | "declined" | "untriaged",
  ) => {
    const found = await files.findMany({
      filter: filter as never,
      limit: 1_000,
    });
    for (const file of found) {
      const failed = file.storageKey
        ? await removeObjects(
            media,
            fileObjectKeys(organisationId, file.storageKey),
          )
        : 0;
      purged.failed += failed;
      if (failed > 0) continue;
      await files.hardDelete(file._id);
      purged[counter] += 1;
    }
  };
  await sweep({ state: "pending", expiresAt: { $lte: now } }, "pending");
  if (declined.length > 0) {
    await sweep({ reportId: { $in: declined.map((r) => r._id) } }, "declined");
  }
  if (untriaged.length > 0) {
    await sweep(
      { reportId: { $in: untriaged.map((r) => r._id) } },
      "untriaged",
    );
  }
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
        result.value.pending + result.value.declined + result.value.untriaged;
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

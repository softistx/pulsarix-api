import type { TestS3 } from "@softistx/s3/testing";
import { ObjectId } from "mongodb";
import { goodReport, intakeKit } from "~/intake";
import { bucketKeys } from "~/media";
import { tenancy } from "../src/config/db";
import type { Media } from "../src/modules/attachments/public";
import type { ClientReportDocument } from "../src/modules/intake/models";
import type { purgeReportFiles } from "../src/modules/intake/services/files-retention.service";
import { fileObjectKeys } from "../src/modules/intake/services/files-storage.service";

export const DAY = 86_400_000;
export const MINUTE = 60_000;

export type Mongo = Parameters<typeof purgeReportFiles>[0];

export async function setupWith(s3: TestS3, media: Media) {
  const kit = await intakeKit();
  const organisationId = kit.organisation.id;
  const mongo = (await tenancy.databaseOf(organisationId)) as unknown as Mongo;
  // A report in the given state, for the given age.
  const report = async (patch: Partial<ClientReportDocument>) => {
    const { body } = await kit.submit(goodReport());
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
    const data = body?.data as unknown as {
      submitClientReport: { reportId: string };
    };
    const id = new ObjectId(data.submitClientReport.reportId);
    await mongo.db.clientReports.update(id, patch as never);
    return id;
  };
  // A stored file of a report: a record and its objects in the bucket.
  const file = async (
    reportId: ObjectId,
    patch: { state?: "pending" | "quarantined"; expiresAt?: Date | null } = {},
  ) => {
    const storageKey = crypto.randomUUID();
    const pending = patch.state === "pending";
    // Every object a key can name: `full`, `256` and the original at `<key>` (a PDF's).
    for (const key of fileObjectKeys(organisationId, storageKey)) {
      await media.bucket.put({ key }, new Uint8Array([1, 2, 3]), {
        type: "image/webp",
      });
    }
    return mongo.db.clientReportFiles.create({
      reportId,
      role: "screenshot",
      fileName: "shot.png",
      mime: "image/png",
      size: 3,
      storageKey,
      previewKey: "256",
      width: 10,
      height: 10,
      state: patch.state ?? "quarantined",
      expiresAt: pending ? (patch.expiresAt ?? null) : null,
    } as never);
  };
  const objects = () => bucketKeys(s3, `organisations/${organisationId}/`);
  return { kit, organisationId, mongo, report, file, objects };
}

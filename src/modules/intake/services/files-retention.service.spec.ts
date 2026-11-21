import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { ObjectId } from "mongodb";
import { goodReport, intakeKit } from "~/intake";
import { bucketKeys, startMediaS3 } from "~/media";
import { tenancy } from "../../../config/db";
import type { Media } from "../../attachments/public";
import { IssuesService } from "../../issues/public";
import {
  DECLINED_FILES_DAYS,
  PENDING_SLOT_MINUTES,
  purgeAllReportFiles,
  purgeReportFiles,
  UNTRIAGED_FILES_DAYS,
} from "./files-retention.service";
import { fileObjectKeys, purgeOrganisationFiles } from "./files-storage.service";
import { ReportsService } from "./reports.service";
import type { ClientReportDocument } from "../models";

const DAY = 86_400_000;
const MINUTE = 60_000;

let s3: TestS3;
let media: Media;
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

type Mongo = Parameters<typeof purgeReportFiles>[0];

async function setup() {
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

describe("the report files purge", () => {
  test("a declined report's files go 7 days after the decision, objects and records", async () => {
    const { mongo, organisationId, report, file, objects } = await setup();
    const now = new Date();
    const due = await report({
      state: "declined",
      decidedAt: new Date(now.getTime() - DECLINED_FILES_DAYS * DAY),
    });
    const early = await report({
      state: "declined",
      decidedAt: new Date(now.getTime() - (DECLINED_FILES_DAYS - 1) * DAY),
    });
    await file(due);
    await file(due);
    const kept = await file(early);
    expect((await objects()).length).toBe(9);
    const purged = await purgeReportFiles(mongo, media, organisationId, now);
    expect(purged).toMatchObject({
      declined: 2,
      pending: 0,
      untriaged: 0,
      failed: 0,
    });
    expect(await mongo.db.clientReportFiles.count({ reportId: due })).toBe(0);
    // Only the early one's objects are left.
    expect(await objects()).toEqual(
      fileObjectKeys(organisationId, kept.storageKey as string).sort(),
    );
    // The report itself stays.
    expect(await mongo.db.clientReports.findById(due)).toBeDefined();
  });

  test("a pending slot with no expiry is purged once it is older than its ticket", async () => {
    const { mongo, organisationId, report, file } = await setup();
    const now = new Date();
    const id = await report({ state: "new" });
    const fresh = await file(id, { state: "pending", expiresAt: null });
    const stale = await file(id, { state: "pending", expiresAt: null });
    await mongo.db.clientReportFiles.raw.updateOne(
      { _id: stale._id },
      {
        $set: {
          createdAt: new Date(
            now.getTime() - (PENDING_SLOT_MINUTES + 1) * MINUTE,
          ),
        },
      },
    );
    const purged = await purgeReportFiles(mongo, media, organisationId, now);
    expect(purged.pending).toBe(1);
    expect(
      await mongo.db.clientReportFiles.findById(stale._id),
    ).toBeUndefined();
    expect(await mongo.db.clientReportFiles.findById(fresh._id)).toBeDefined();
  });

  test("more due files than a page are all purged", async () => {
    const { mongo, organisationId, report, file } = await setup();
    const now = new Date();
    const due = new Date(now.getTime() - DECLINED_FILES_DAYS * DAY);
    for (let n = 0; n < 3; n++) {
      const id = await report({ state: "declined", decidedAt: due });
      await file(id);
      await file(id);
    }
    const purged = await purgeReportFiles(mongo, media, organisationId, now, 2);
    expect(purged.declined).toBe(6);
    expect(await mongo.db.clientReportFiles.count({})).toBe(0);
  });

  test("the sweep starts from the files: reports with no files left are never read", async () => {
    const { mongo, organisationId, report, file } = await setup();
    const now = new Date();
    const old = new Date(now.getTime() - DECLINED_FILES_DAYS * DAY);
    // Old declined reports whose files are already gone, and one with files.
    const gone = [
      await report({ state: "declined", decidedAt: old }),
      await report({ state: "declined", decidedAt: old }),
    ];
    const held = await report({ state: "declined", decidedAt: old });
    await file(held);
    const reads: unknown[] = [];
    const raw = mongo.db.clientReports.raw;
    const find = raw.find.bind(raw);
    (raw as { find: unknown }).find = (filter: unknown, ...rest: unknown[]) => {
      reads.push(filter);
      return (find as (...a: unknown[]) => unknown)(filter, ...rest);
    };
    try {
      const purged = await purgeReportFiles(mongo, media, organisationId, now);
      expect(purged.declined).toBe(1);
    } finally {
      (raw as { find: unknown }).find = find;
    }
    expect(reads.length).toBeGreaterThan(0);
    // Every read of the reports is by `_id` among the reports holding files.
    for (const filter of reads) {
      const ids = (filter as { _id?: { $in?: ObjectId[] } })._id?.$in;
      expect(ids).toBeDefined();
      for (const id of gone) {
        expect(ids?.some((x) => x.equals(id))).toBe(false);
      }
    }
  });

  test("a report nobody triaged loses its files after 90 days, an accepted one never", async () => {
    const { mongo, organisationId, report, file, objects } = await setup();
    const now = new Date();
    const old = new Date(now.getTime() - UNTRIAGED_FILES_DAYS * DAY - MINUTE);
    const untriaged = await report({ state: "new" });
    const accepted = await report({ state: "accepted", decidedAt: old });
    for (const id of [untriaged, accepted]) {
      await mongo.db.clientReports.raw.updateOne(
        { _id: id },
        { $set: { createdAt: old } },
      );
    }
    await file(untriaged);
    const released = await file(accepted);
    const purged = await purgeReportFiles(mongo, media, organisationId, now);
    expect(purged).toMatchObject({ untriaged: 1, declined: 0 });
    expect(
      await mongo.db.clientReportFiles.count({ reportId: untriaged }),
    ).toBe(0);
    expect(await mongo.db.clientReportFiles.count({ reportId: accepted })).toBe(
      1,
    );
    expect(await objects()).toEqual(
      fileObjectKeys(organisationId, released.storageKey as string).sort(),
    );
  });

  test("a pending slot goes after 15 minutes, with whatever it stored", async () => {
    const { mongo, organisationId, report, file, objects } = await setup();
    const now = new Date();
    const id = await report({ state: "new" });
    const expired = await file(id, {
      state: "pending",
      expiresAt: new Date(now.getTime() - 1),
    });
    const live = await file(id, {
      state: "pending",
      expiresAt: new Date(now.getTime() + PENDING_SLOT_MINUTES * MINUTE),
    });
    const purged = await purgeReportFiles(mongo, media, organisationId, now);
    expect(purged.pending).toBe(1);
    expect(
      await mongo.db.clientReportFiles.findById(expired._id),
    ).toBeUndefined();
    expect(await mongo.db.clientReportFiles.findById(live._id)).toBeDefined();
    expect(await objects()).toEqual(
      fileObjectKeys(organisationId, live.storageKey as string).sort(),
    );
  });

  test("the job over every organisation leaves no object, and repeating it changes nothing", async () => {
    const { organisationId, mongo, report, file, objects } = await setup();
    const now = new Date();
    const declined = await report({
      state: "declined",
      decidedAt: new Date(now.getTime() - 8 * DAY),
    });
    await file(declined);
    await file(declined, {
      state: "pending",
      expiresAt: new Date(now.getTime() - MINUTE),
    });
    expect((await objects()).length).toBeGreaterThan(0);
    await purgeAllReportFiles(tenancy, media, now);
    expect(await objects()).toEqual([]);
    expect(await mongo.db.clientReportFiles.count({})).toBe(0);
    await purgeAllReportFiles(tenancy, media, now);
    expect(await objects()).toEqual([]);
    expect(organisationId).toBeString();
  });

  test("deleting the organisation removes everything under its prefix, and only its own", async () => {
    const { organisationId, report, file, objects } = await setup();
    await file(await report({ state: "new" }));
    const other = `organisations/${new ObjectId().toHexString()}/report-files/x/full`;
    await media.bucket.put({ key: other }, new Uint8Array([1]), {
      type: "image/webp",
    });
    expect((await objects()).length).toBeGreaterThan(0);
    const removed = await purgeOrganisationFiles(media, organisationId);
    expect(removed).toBeGreaterThan(0);
    expect(await objects()).toEqual([]);
    expect(await bucketKeys(s3, other)).toEqual([other]);
  });
});

describe("a release that failed is retried by the retention job", () => {
  test("an accepted report whose release threw stays accepted, and the purge releases its files", async () => {
    const { kit, mongo, organisationId, report, file } = await setup();
    const id = await report({ state: "new" });
    const stored = await file(id);
    const failures: string[] = [];
    const viewerId = kit.owner.id as string;
    const reports = new ReportsService(
      mongo as never,
      new IssuesService(
        mongo as never,
        async () => true,
        viewerId,
        organisationId,
      ),
      viewerId,
      {
        release: async () => {
          throw new Error("storage down");
        },
        log: (message) => failures.push(message),
      },
    );
    const accepted = await reports.accept(id.toHexString());
    expect(accepted.state).toBe("accepted");
    expect(failures).toHaveLength(1);
    expect(await mongo.db.clientReportFiles.findById(stored._id)).toMatchObject(
      { state: "quarantined" },
    );
    const purged = await purgeReportFiles(mongo, media, organisationId);
    expect(purged.released).toBe(1);
    expect(await mongo.db.clientReportFiles.findById(stored._id)).toMatchObject(
      { state: "released", expiresAt: null },
    );
    // Idempotent: a second pass has nothing left to release.
    expect(
      (await purgeReportFiles(mongo, media, organisationId)).released,
    ).toBe(0);
  });

  test("a quarantined file of an accepted or closed report is released, a declined one is not", async () => {
    const { mongo, organisationId, report, file } = await setup();
    const accepted = await file(await report({ state: "accepted" }));
    const closed = await file(await report({ state: "closed" }));
    const newer = await file(await report({ state: "new" }));
    const purged = await purgeReportFiles(mongo, media, organisationId);
    expect(purged.released).toBe(2);
    for (const [stored, state] of [
      [accepted, "released"],
      [closed, "released"],
      [newer, "quarantined"],
    ] as const)
      expect(
        await mongo.db.clientReportFiles.findById(stored._id),
      ).toMatchObject({ state });
  });
});

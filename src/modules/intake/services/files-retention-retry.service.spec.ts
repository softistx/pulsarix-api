import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { setupWith } from "~/files-retention";
import { startMediaS3 } from "~/media";
import type { Media } from "../../attachments/public";
import { IssuesService } from "../../issues/public";
import { purgeReportFiles } from "./files-retention.service";
import { ReportsService } from "./reports.service";

let s3: TestS3;
let media: Media;
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const setup = () => setupWith(s3, media);

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
        "UTC",
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

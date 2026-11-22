import { describe, expect, test } from "bun:test";
import { dbOf } from "@softistx/alxia-tenancy";
import { migrate } from "@softistx/mongo/migrations";
import { ObjectId } from "mongodb";
import { authApp, ownerWithOrganisation } from "~/auth";
import { tenancy } from "../../config/db";
import { migrations } from "./index";

const kit = authApp();
const ID = "2026-11-22-request-links";
const now = new Date("2026-11-20T10:00:00Z");
const decided = new Date("2026-11-21T10:00:00Z");

describe("request-links", () => {
  test("one link per report with an issue, and a second run changes nothing", async () => {
    const { organisation } = await ownerWithOrganisation(kit);
    const db = dbOf(await tenancy.databaseOf(organisation.id));
    await db.collection("nxgt_migrations").deleteOne({ _id: ID as never });
    const raw = { bypassDocumentValidation: true };
    const linked = new ObjectId();
    const open = new ObjectId();
    const issueId = new ObjectId();
    const by = "0198a2f0-0000-7000-8000-000000000001";
    await db.collection("clientReports").insertMany(
      [
        {
          _id: linked,
          issueId,
          decidedBy: by,
          decidedAt: decided,
          createdAt: now,
        },
        { _id: open, issueId: null, createdAt: now },
      ],
      raw,
    );

    const result = await migrate(db, migrations);
    expect(result.applied.map((a) => a.id)).toContain(ID);
    const links = await db.collection("clientReportLinks").find().toArray();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      reportId: linked,
      issueId,
      linkedAt: decided,
      linkedBy: by,
    });
    // The report keeps its issue (the deprecated first link).
    const report = await db
      .collection("clientReports")
      .findOne({ _id: linked });
    expect(report?.["issueId"]).toEqual(issueId);

    await db.collection("nxgt_migrations").deleteOne({ _id: ID as never });
    await migrate(db, migrations);
    expect(await db.collection("clientReportLinks").countDocuments()).toBe(1);
  }, 30_000);
});

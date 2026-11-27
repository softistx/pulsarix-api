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

const earlier = new Date("2026-11-19T10:00:00Z");
const SYSTEM = "00000000-0000-7000-8000-000000000000";

describe("request-links", () => {
  test("one link per report with an issue, with the linkedAt fallback, and a second run changes nothing", async () => {
    const { organisation } = await ownerWithOrganisation(kit);
    const db = dbOf(await tenancy.databaseOf(organisation.id));
    await db.collection("nxgt_migrations").deleteMany({
      _id: { $in: [ID, "2026-11-26-plan-rank"] as never[] },
    });
    const raw = { bypassDocumentValidation: true };
    const linked = new ObjectId();
    const open = new ObjectId();
    const issueId = new ObjectId();
    const kept = new ObjectId();
    const keptIssue = new ObjectId();
    const bare = new ObjectId();
    const bareIssue = new ObjectId();
    const explicit = new ObjectId();
    const explicitIssue = new ObjectId();
    const by = "0198a2f0-0000-7000-8000-000000000001";
    const other = "0198a2f0-0000-7000-8000-000000000002";
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
        // Its link row exists already, made by someone else.
        {
          _id: kept,
          issueId: keptIssue,
          decidedBy: by,
          decidedAt: decided,
          createdAt: now,
        },
        // Only `createdAt`: the last of the fallback, stamped by the system.
        { _id: bare, issueId: bareIssue, createdAt: now },
        // `linkedAt` wins over `decidedAt`.
        {
          _id: explicit,
          issueId: explicitIssue,
          linkedAt: earlier,
          decidedBy: by,
          decidedAt: decided,
          createdAt: now,
        },
      ],
      raw,
    );
    await db.collection("clientReportLinks").insertOne(
      {
        reportId: kept,
        issueId: keptIssue,
        linkedAt: earlier,
        linkedBy: other,
      },
      raw,
    );

    const result = await migrate(db, migrations);
    expect(result.applied.map((a) => a.id)).toContain(ID);
    const linkOf = (reportId: ObjectId) =>
      db.collection("clientReportLinks").findOne({ reportId });
    const links = await db.collection("clientReportLinks").find().toArray();
    expect(links).toHaveLength(4);
    expect(await linkOf(linked)).toMatchObject({
      issueId,
      linkedAt: decided,
      linkedBy: by,
    });
    // The existing row is untouched (`$setOnInsert`).
    const existing = await linkOf(kept);
    expect(existing).toMatchObject({ linkedAt: earlier, linkedBy: other });
    expect(existing?.["createdAt"]).toBeUndefined();
    expect(await linkOf(bare)).toMatchObject({
      issueId: bareIssue,
      linkedAt: now,
      linkedBy: SYSTEM,
    });
    expect(await linkOf(explicit)).toMatchObject({
      linkedAt: earlier,
      linkedBy: by,
    });
    expect(await linkOf(open)).toBeNull();
    // The report keeps its issue (the deprecated first link).
    const report = await db
      .collection("clientReports")
      .findOne({ _id: linked });
    expect(report?.["issueId"]).toEqual(issueId);

    await db.collection("nxgt_migrations").deleteMany({
      _id: { $in: [ID, "2026-11-26-plan-rank"] as never[] },
    });
    await migrate(db, migrations);
    const again = await db.collection("clientReportLinks").find().toArray();
    expect(again).toHaveLength(4);
    const dates = (rows: typeof links) =>
      rows
        .map((row) => [String(row["reportId"]), row["linkedAt"]])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(dates(again)).toEqual(dates(links));
  }, 30_000);
});

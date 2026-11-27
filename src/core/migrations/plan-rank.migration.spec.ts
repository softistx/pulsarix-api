import { describe, expect, test } from "bun:test";
import { dbOf } from "@softistx/alxia-tenancy";
import { migrate } from "@softistx/mongo/migrations";
import { ObjectId } from "mongodb";
import { authApp, ownerWithOrganisation } from "~/auth";
import { tenancy } from "../../config/db";
import { migrations } from "./index";

const kit = authApp();
const ID = "2026-11-26-plan-rank";

describe("plan-rank", () => {
  test("an issue with no plan rank gets its board rank, one with a plan rank keeps it, and a second run changes nothing", async () => {
    const { organisation } = await ownerWithOrganisation(kit);
    const db = dbOf(await tenancy.databaseOf(organisation.id));
    await db.collection("nxgt_migrations").deleteOne({ _id: ID as never });
    const raw = { bypassDocumentValidation: true };
    const old = new ObjectId();
    const planned = new ObjectId();
    await db.collection("issues").insertMany(
      [
        {
          _id: old,
          key: "A-1",
          projectId: new ObjectId(),
          number: 1,
          rank: "M",
        },
        {
          _id: planned,
          key: "A-2",
          projectId: new ObjectId(),
          number: 1,
          rank: "M",
          planRank: "Q",
        },
      ],
      raw,
    );
    const result = await migrate(db, migrations);
    expect(result.applied.map((a) => a.id)).toContain(ID);
    const rankOf = async (_id: ObjectId) =>
      (await db.collection("issues").findOne({ _id }))?.["planRank"];
    expect(await rankOf(old)).toBe("M");
    expect(await rankOf(planned)).toBe("Q");
    await db.collection("nxgt_migrations").deleteOne({ _id: ID as never });
    await migrate(db, migrations);
    expect(await rankOf(old)).toBe("M");
    expect(await rankOf(planned)).toBe("Q");
  }, 30_000);
});

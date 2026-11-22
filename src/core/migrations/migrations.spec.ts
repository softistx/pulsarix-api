import { describe, expect, test } from "bun:test";
import { dbOf } from "@softistx/alxia-tenancy";
import { migrate, migrationStatus } from "@softistx/mongo/migrations";
import { ObjectId } from "mongodb";
import { authApp, ownerWithOrganisation } from "~/auth";
import { tenancy } from "../../config/db";
import { migrations } from "./index";

const kit = authApp();

// A fresh organisation: provisioned through the API, so its database was
// migrated by `provision`. Returns its driver handle.
async function organisationDb() {
  const { organisation } = await ownerWithOrganisation(kit);
  return dbOf(await tenancy.databaseOf(organisation.id));
}

// Makes the migration pending again, as on a database that predates it.
const ISSUE_TYPES = "2026-11-21-issue-types";
const forget = (db: ReturnType<typeof dbOf>) =>
  db.collection("nxgt_migrations").deleteOne({ _id: ISSUE_TYPES as never });

const now = new Date();
const base = (projectId: ObjectId, number: number) => ({
  projectId,
  number,
  key: `P-${number}`,
  title: `Issue ${number}`,
  statusId: new ObjectId(),
  rank: "m",
  createdAt: now,
  updatedAt: now,
});

async function seed(db: ReturnType<typeof dbOf>) {
  const projectId = new ObjectId();
  const bug = new ObjectId();
  const other = new ObjectId();
  // Past the validator: documents of the previous shape.
  const raw = { bypassDocumentValidation: true };
  await db.collection("labels").insertMany(
    [
      { _id: bug, projectId, name: "BUG", createdAt: now, updatedAt: now },
      { _id: other, projectId, name: "ui", createdAt: now, updatedAt: now },
    ],
    raw,
  );
  const parent = new ObjectId();
  const typed = new ObjectId();
  const docs = {
    plain: { _id: new ObjectId(), ...base(projectId, 1), labelIds: [other] },
    labelled: { _id: new ObjectId(), ...base(projectId, 2), labelIds: [bug] },
    child: {
      _id: new ObjectId(),
      ...base(projectId, 3),
      labelIds: [],
      parentId: parent,
    },
    both: {
      _id: new ObjectId(),
      ...base(projectId, 4),
      labelIds: [bug],
      parentId: parent,
    },
    typed: {
      _id: typed,
      ...base(projectId, 5),
      labelIds: [bug],
      type: "story",
    },
  };
  await db.collection("issues").insertMany(Object.values(docs), raw);
  return docs;
}

const typesOf = async (
  db: ReturnType<typeof dbOf>,
  docs: Record<string, { _id: ObjectId }>,
) => {
  const rows = await db
    .collection("issues")
    .find({ _id: { $in: Object.values(docs).map((d) => d._id) } })
    .toArray();
  const byId = new Map(rows.map((r) => [r._id.toHexString(), r]));
  return Object.fromEntries(
    Object.entries(docs).map(([name, d]) => [
      name,
      byId.get(d._id.toHexString()),
    ]),
  );
};

describe("the migrations list", () => {
  test("ids are unique and issue-types is first", () => {
    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(ISSUE_TYPES);
  });

  test("a new organisation is born with every migration recorded", async () => {
    const db = await organisationDb();
    const status = await migrationStatus(db, migrations);
    expect(status.map((s) => s.id)).toEqual(migrations.map((m) => m.id));
    expect(status.every((s) => s.state === "applied")).toBe(true);
  }, 30_000);
});

describe("issue-types", () => {
  test("types the four cases and leaves a typed issue alone", async () => {
    const db = await organisationDb();
    await forget(db);
    const docs = await seed(db);
    const before = await db.collection("labels").find().toArray();

    const result = await migrate(db, migrations);
    expect(result.applied.map((a) => a.id)).toEqual([ISSUE_TYPES]);

    const after = await typesOf(db, docs);
    expect(after["plain"]?.["type"]).toBe("task");
    expect(after["labelled"]?.["type"]).toBe("bug");
    expect(after["child"]?.["type"]).toBe("subTask");
    expect(after["both"]?.["type"]).toBe("subTask");
    expect(after["typed"]?.["type"]).toBe("story");
    // Labels and links are kept, and no stamp moves.
    expect(after["both"]?.["labelIds"]).toEqual(docs.both.labelIds);
    expect(after["both"]?.["parentId"]).toEqual(docs.both.parentId);
    expect(after["plain"]?.["updatedAt"]).toEqual(now);
    expect(await db.collection("labels").find().toArray()).toEqual(before);
  }, 30_000);

  test("a second run changes nothing", async () => {
    const db = await organisationDb();
    await forget(db);
    const docs = await seed(db);
    await migrate(db, migrations);
    const first = await typesOf(db, docs);

    const again = await migrate(db, migrations);
    expect(again.applied).toEqual([]);
    // Forced through the migration itself: a type already set is not touched.
    await forget(db);
    await migrate(db, migrations);
    expect(await typesOf(db, docs)).toEqual(first);
  }, 30_000);
});

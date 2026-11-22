import { describe, expect, test } from "bun:test";
import { dbOf } from "@softistx/alxia-tenancy";
import { ObjectId } from "mongodb";
import { authApp, ownerWithOrganisation } from "~/auth";
import { tenancy } from "./db";
import { migrateAtBoot } from "./migrate-at-boot";

const kit = authApp();

const quiet = async <T>(run: () => Promise<T>) => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
};

describe("migrateAtBoot", () => {
  test("migrates an organisation that predates a migration", async () => {
    const { organisation } = await ownerWithOrganisation(kit);
    const db = dbOf(await tenancy.databaseOf(organisation.id));
    await db
      .collection("nxgt_migrations")
      .deleteOne({ _id: "2026-11-21-issue-types" as never });
    const _id = new ObjectId();
    await db.collection("issues").insertOne(
      {
        _id,
        projectId: new ObjectId(),
        number: 1,
        key: "P-1",
        title: "Old",
        statusId: new ObjectId(),
        rank: "m",
        labelIds: [],
      },
      { bypassDocumentValidation: true },
    );

    await quiet(() =>
      migrateAtBoot(tenancy, (() => {
        throw new Error("no exit expected");
      }) as never),
    );
    expect((await db.collection("issues").findOne({ _id }))?.["type"]).toBe(
      "task",
    );
    // A second boot has nothing left to apply.
    await quiet(() =>
      migrateAtBoot(tenancy, (() => {
        throw new Error("no exit expected");
      }) as never),
    );
  }, 60_000);

  test("a failing organisation exits 1", async () => {
    const codes: number[] = [];
    await quiet(() =>
      migrateAtBoot(
        {
          migrateTenants: async () => [
            { tenant: "a", database: "db_a", ok: false, error: new Error("x") },
          ],
        },
        ((code: number) => {
          codes.push(code);
        }) as never,
      ),
    );
    expect(codes).toEqual([1]);
  });

  test("a failing run exits 1", async () => {
    const codes: number[] = [];
    await quiet(() =>
      migrateAtBoot(
        {
          migrateTenants: async () => {
            throw new Error("down");
          },
        },
        ((code: number) => {
          codes.push(code);
        }) as never,
      ),
    );
    expect(codes).toEqual([1]);
  });
});

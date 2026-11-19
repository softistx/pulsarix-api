import { describe, expect, test } from "bun:test";
import { dbOf } from "@alxia/tenancy";
import { syncCoreAtBoot, syncCoreDatabase } from "./core-sync";
import { coreMongo } from "./db";

describe("syncCoreDatabase", () => {
  test("creates janus's collections and is idempotent", async () => {
    await syncCoreDatabase(coreMongo);
    await syncCoreDatabase(coreMongo);
    const names = (await dbOf(coreMongo).listCollections().toArray()).map(
      (c) => c.name,
    );
    expect(names).toContain("organisations");
    expect(names).toContain("sessions");
  });
});

describe("syncCoreAtBoot", () => {
  test("runs the sync", async () => {
    let calls = 0;
    await syncCoreAtBoot(
      coreMongo,
      (() => {
        throw new Error("no exit expected");
      }) as never,
      async () => {
        calls++;
      },
    );
    expect(calls).toBe(1);
  });

  test("a failing sync exits 1", async () => {
    const codes: number[] = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      await syncCoreAtBoot(
        coreMongo,
        ((code: number) => {
          codes.push(code);
        }) as never,
        async () => {
          throw new Error("boom");
        },
      );
    } finally {
      console.error = quiet;
    }
    expect(codes).toEqual([1]);
  });
});

test("the server boots through syncCoreAtBoot before listening", async () => {
  const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();
  const sync = source.indexOf("syncCoreAtBoot(coreMongo)");
  expect(sync).toBeGreaterThan(-1);
  expect(sync).toBeLessThan(source.indexOf("app.listen"));
});

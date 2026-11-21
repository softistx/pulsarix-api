import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { AddComment, world } from "~/requests";
import { openLedger } from "./requests-live.service";
import type { Session } from "./requests-session.service";

describe("the live stream's unread ledger", () => {
  test("recounts the changed request only and keeps the total", async () => {
    const w = await world();
    const ids = [await w.file("ada"), await w.file("ada"), await w.file("ada")];
    const issues = [];
    for (const id of ids) issues.push(await w.accept(id));
    const comment = (issueId: string) =>
      w.kit.asOwner.call(AddComment, {
        issueId,
        input: { body: "Looking", public: true },
      });
    await comment(issues[0] as string);
    await comment(issues[0] as string);
    await comment(issues[1] as string);
    const first = await w.mongo.db.clientReports.findFirst({
      _id: new ObjectId(ids[0]),
    });
    if (!first) throw new Error("report missing");
    const session = {
      mongo: w.mongo,
      reporter: { keyId: first.widgetKeyId, reporterKey: first.reporterKey },
    } as unknown as Session;

    const seen: number[] = [];
    const raw = w.mongo.db.comments.raw;
    const aggregate = raw.aggregate.bind(raw);
    raw.aggregate = ((
      pipeline: { $match?: { issueId?: { $in: unknown[] } } }[],
    ) => {
      seen.push(pipeline[0]?.$match?.issueId?.$in.length ?? 0);
      return aggregate(pipeline as never);
    }) as typeof raw.aggregate;
    try {
      const ledger = await openLedger(session);
      expect(ledger.total()).toBe(3);
      expect(seen).toEqual([3]);

      await comment(issues[2] as string);
      seen.length = 0;
      const changed = await ledger.update(ids[2] as string);
      expect(changed).toMatchObject({
        update: { id: ids[2], unread: 1 },
        total: 4,
      });
      expect(seen).toEqual([1]);
      expect(await ledger.update("0".repeat(24))).toBeNull();
      expect(await ledger.update("not-an-id")).toBeNull();
      expect(ledger.total()).toBe(4);
    } finally {
      raw.aggregate = aggregate;
    }
  });
});

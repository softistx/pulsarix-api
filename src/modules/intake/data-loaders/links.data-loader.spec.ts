import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IntakeMongo } from "../intake.types";
import { linksLoader } from "./links.data-loader";

describe("linksLoader", () => {
  test("the issues of N reports are two grouped reads, in link order", async () => {
    const [a, b, c] = [new ObjectId(), new ObjectId(), new ObjectId()];
    const issue = () => {
      const _id = new ObjectId();
      return { _id, id: _id.toHexString() };
    };
    const [i1, i2, i3] = [issue(), issue(), issue()];
    const link = (reportId: ObjectId, issueId: ObjectId) => ({
      reportId,
      issueId,
    });
    const reads = { links: 0, issues: 0 };
    const mongo = {
      db: {
        clientReportLinks: {
          findMany: () => {
            reads.links++;
            return Promise.resolve([
              link(a, i2._id),
              link(a, i1._id),
              link(b, i3._id),
              link(b, new ObjectId()),
            ]);
          },
        },
        issues: {
          findMany: () => {
            reads.issues++;
            return Promise.resolve([i1, i2, i3]);
          },
        },
      },
    } as unknown as IntakeMongo;
    const loader = linksLoader(() => Promise.resolve(mongo));
    const found = await Promise.all(
      [a, b, c].map((id) => loader.load(id.toHexString())),
    );
    expect(reads).toEqual({ links: 1, issues: 1 });
    expect(found.map((issues) => issues.map((i) => i.id))).toEqual([
      [i2.id, i1.id],
      [i3.id],
      [],
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import { linkedIssueIds, reportsOfIssues } from "./linked-reports.service";

const oid = () => {
  const _id = new ObjectId();
  return { _id, id: _id.toHexString() };
};

describe("linkedIssueIds", () => {
  test("links come in order; a report with no link row falls back to its issueId", async () => {
    const [withLinks, legacy, bare] = [oid(), oid(), oid()];
    const [i1, i2, i3] = [oid(), oid(), oid()];
    const mongo = {
      db: {
        clientReportLinks: {
          findMany: () =>
            Promise.resolve([
              { reportId: withLinks._id, issueId: i2._id },
              { reportId: withLinks._id, issueId: i1._id },
            ]),
        },
      },
    } as unknown as ModuleMongo<"intake">;
    const found = await linkedIssueIds(mongo, [
      { ...withLinks, issueId: i1._id },
      { ...legacy, issueId: i3._id },
      { ...bare, issueId: null },
    ]);
    expect(found.get(withLinks.id)?.map((id) => id.toHexString())).toEqual([
      i2.id,
      i1.id,
    ]);
    expect(found.get(legacy.id)?.map((id) => id.toHexString())).toEqual([
      i3.id,
    ]);
    expect(found.get(bare.id)).toEqual([]);
  });
});

describe("reportsOfIssues", () => {
  test("a legacy report with no link row counts on its issue; erased ones are filtered by the read", async () => {
    const issue = oid();
    const legacy = { ...oid(), issueId: issue._id };
    let filter: unknown;
    const mongo = {
      db: {
        clientReportLinks: { findMany: () => Promise.resolve([]) },
        clientReports: {
          findMany: (q: { filter: unknown }) => {
            filter = q.filter;
            return Promise.resolve([legacy]);
          },
        },
      },
    } as unknown as ModuleMongo<"intake">;
    const found = await reportsOfIssues(mongo, [issue._id]);
    expect(found.get(issue.id)?.map((r) => r.id)).toEqual([legacy.id]);
    expect(JSON.stringify(filter)).toContain('"erasedAt":null');
  });
});

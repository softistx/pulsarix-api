import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument } from "../models";
import { publicStateLoader } from "./public-state.data-loader";

function fake() {
  const issue = () => {
    const _id = new ObjectId();
    return { _id, id: _id.toHexString(), statusId: new ObjectId() };
  };
  const open = issue();
  const done = issue();
  const reads = { issues: 0, statuses: 0 };
  const mongo = {
    db: {
      issues: {
        findMany: () => {
          reads.issues++;
          return Promise.resolve([open, done]);
        },
      },
      statuses: {
        findMany: () => {
          reads.statuses++;
          return Promise.resolve([
            {
              _id: open.statusId,
              id: open.statusId.toHexString(),
              category: "inProgress",
            },
            {
              _id: done.statusId,
              id: done.statusId.toHexString(),
              category: "done",
            },
          ]);
        },
      },
    },
  } as unknown as IntakeMongo;
  const report = (issue?: { _id: ObjectId }) =>
    ({
      _id: new ObjectId(),
      id: new ObjectId().toHexString(),
      state: "accepted",
      issueId: issue?._id ?? null,
    }) as unknown as ClientReportDocument;
  return { mongoOf: () => Promise.resolve(mongo), reads, report, open, done };
}

describe("publicStateLoader", () => {
  test("N reports are one read of the issues and one of the statuses", async () => {
    const { mongoOf, reads, report, open, done } = fake();
    const loader = publicStateLoader(mongoOf);
    const states = await Promise.all([
      loader.load(report(open)),
      loader.load(report(done)),
      loader.load(report()),
    ]);
    expect(reads).toEqual({ issues: 1, statuses: 1 });
    expect(states).toEqual(["inProgress", "resolved", "received"]);
  });

  test("a rejected guard rejects every report of the batch", async () => {
    const { report } = fake();
    const loader = publicStateLoader(() => Promise.reject(new Error("no")));
    const results = await Promise.allSettled([
      loader.load(report()),
      loader.load(report()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});

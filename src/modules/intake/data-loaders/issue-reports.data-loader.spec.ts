import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IntakeMongo } from "../intake.types";
import {
  issueReportsLoader,
  waitingClientsLoader,
} from "./issue-reports.data-loader";

function fake() {
  const make = (category: string) => {
    const statusId = new ObjectId();
    const _id = new ObjectId();
    return {
      issue: { _id, id: _id.toHexString(), statusId },
      status: { _id: statusId, id: statusId.toHexString(), category },
    };
  };
  const done = make("done");
  const doing = make("inProgress");
  const report = () => {
    const _id = new ObjectId();
    return { _id, id: _id.toHexString(), state: "accepted", issueId: null };
  };
  // `both` waits on two issues (one done, one in progress); `finished` only
  // has done ones, so it is resolved and does not wait.
  const both = report();
  const finished = report();
  const link = (r: { _id: ObjectId }, i: { _id: ObjectId }) => ({
    reportId: r._id,
    issueId: i._id,
  });
  const links = [
    link(both, done.issue),
    link(both, doing.issue),
    link(finished, done.issue),
  ];
  const reads = { links: 0, reports: 0, filters: [] as unknown[] };
  const mongo = {
    db: {
      clientReportLinks: {
        findMany: (q: { filter: { issueId?: unknown } }) => {
          // The loader asks by issue; the state read asks by report.
          if (q.filter.issueId) reads.links++;
          return Promise.resolve(links);
        },
      },
      clientReports: {
        findMany: (q: { filter: unknown }) => {
          reads.reports++;
          reads.filters.push(q.filter);
          return Promise.resolve([both, finished]);
        },
      },
      issues: { findMany: () => Promise.resolve([done.issue, doing.issue]) },
      statuses: {
        findMany: () => Promise.resolve([done.status, doing.status]),
      },
    },
  } as unknown as IntakeMongo;
  return { mongo, reads, both, finished, done, doing };
}

describe("issueReportsLoader", () => {
  test("the issues of a page share one read of links and one of reports, erased ones excluded", async () => {
    const { mongo, reads, both, finished, done, doing } = fake();
    const loader = issueReportsLoader(() => Promise.resolve(mongo));
    const [onDone, onDoing] = await Promise.all([
      loader.load(done.issue.id),
      loader.load(doing.issue.id),
    ]);
    expect(reads.links).toBe(1);
    expect(reads.reports).toBe(1);
    expect(JSON.stringify(reads.filters[0])).toContain('"erasedAt":null');
    expect(onDone.map((r) => r.id).sort()).toEqual(
      [both.id, finished.id].sort(),
    );
    expect(onDoing.map((r) => r.id)).toEqual([both.id]);
  });

  test("is not cached: a second load reads again", async () => {
    const { mongo, reads, done } = fake();
    const loader = issueReportsLoader(() => Promise.resolve(mongo));
    await loader.load(done.issue.id);
    await loader.load(done.issue.id);
    expect(reads.reports).toBe(2);
  });
});

describe("waitingClientsLoader", () => {
  test("counts requests not resolved, declined or erased; a request on two issues counts on each", async () => {
    const { mongo, done, doing } = fake();
    const loader = waitingClientsLoader(() => Promise.resolve(mongo));
    const [onDone, onDoing] = await Promise.all([
      loader.load(done.issue.id),
      loader.load(doing.issue.id),
    ]);
    // `both` is in progress through its second issue and waits on each of
    // its issues; `finished` is resolved.
    expect(onDone).toBe(1);
    expect(onDoing).toBe(1);
  });

  test("an unknown issue has none", async () => {
    const { mongo } = fake();
    const loader = waitingClientsLoader(() => Promise.resolve(mongo));
    expect(await loader.load(new ObjectId().toHexString())).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { IssueChange } from "../../issues/public";
import { followIssue } from "./closing.service";

const oid = () => new ObjectId();

interface Report {
  _id: ObjectId;
  id: string;
  state: string;
  issueId: ObjectId | null;
  clientWaiting?: boolean;
  closedAt?: Date | null;
  erasedAt?: Date | null;
}

// The few collections the follower reads, over plain arrays: `settled` names
// the issues sitting in a done status.
function world(
  reports: Report[],
  links: [ObjectId, ObjectId][],
  settled: ObjectId[],
) {
  const rows = links.map(([reportId, issueId]) => ({ reportId, issueId }));
  const updates: unknown[] = [];
  const filesUpdates: unknown[] = [];
  const same = (a: ObjectId | null | undefined, b: ObjectId) => !!a?.equals(b);
  const db = {
    clientReportLinks: {
      findMany: ({ filter }: { filter: Record<string, unknown> }) => {
        const issue = filter["issueId"] as ObjectId | undefined;
        const ids = (filter["reportId"] as { $in: ObjectId[] } | undefined)
          ?.$in;
        return Promise.resolve(
          rows.filter((row) =>
            issue
              ? row.issueId.equals(issue)
              : ids?.some((id) => id.equals(row.reportId)),
          ),
        );
      },
      exists: ({
        reportId,
        issueId,
      }: {
        reportId: ObjectId;
        issueId: ObjectId;
      }) =>
        Promise.resolve(
          rows.some(
            (r) => r.reportId.equals(reportId) && r.issueId.equals(issueId),
          ),
        ),
      create: (row: { reportId: ObjectId; issueId: ObjectId }) => {
        rows.push(row);
        return Promise.resolve(row);
      },
      hardDeleteMany: ({ issueId }: { issueId: ObjectId }) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.issueId.equals(issueId)) rows.splice(i, 1);
        }
        return Promise.resolve(0);
      },
    },
    clientReports: {
      findMany: ({
        filter,
      }: {
        filter: { $or: Record<string, unknown>[] };
      }) => {
        const [byLink, byIssue] = filter.$or as [
          { _id: { $in: ObjectId[] } },
          { issueId: ObjectId },
        ];
        const ids = byLink._id.$in;
        const issueId = byIssue.issueId;
        return Promise.resolve(
          reports.filter(
            (r) =>
              ids.some((id) => id.equals(r._id)) || same(r.issueId, issueId),
          ),
        );
      },
      findById: (id: ObjectId) =>
        Promise.resolve(reports.find((r) => r._id.equals(id)) ?? null),
      update: (id: ObjectId, patch: Partial<Report>) => {
        updates.push(patch);
        const report = reports.find((r) => r._id.equals(id));
        if (report) Object.assign(report, patch);
        return Promise.resolve(report ?? null);
      },
    },
    clientReportFiles: {
      updateMany: (...args: unknown[]) => {
        filesUpdates.push(args);
        return Promise.resolve(0);
      },
    },
    issues: {
      findById: (id: ObjectId) =>
        Promise.resolve({
          _id: id,
          statusId: settled.some((s) => s.equals(id)) ? "done" : "todo",
        }),
    },
    statuses: {
      findById: (id: string) =>
        Promise.resolve({ category: id === "done" ? "done" : "started" }),
    },
  };
  return { tx: { db } as never, rows, updates, filesUpdates };
}

const change = (
  verb: string,
  issueId: ObjectId,
  statusId: string,
  clientReportId: ObjectId | null = null,
) =>
  ({
    verb,
    actorId: "a",
    issue: { _id: issueId, statusId, clientReportId },
  }) as unknown as IssueChange;

const report = (
  state = "accepted",
  issueId: ObjectId | null = null,
): Report => {
  const _id = oid();
  return { _id, id: _id.toHexString(), state, issueId };
};

describe("followIssue", () => {
  test("a created issue gets its link once", async () => {
    const r = report("new");
    const issueId = oid();
    const w = world([r], [], []);
    await followIssue(w.tx, change("created", issueId, "todo", r._id));
    await followIssue(w.tx, change("created", issueId, "todo", r._id));
    expect(w.rows).toHaveLength(1);
    expect(r.issueId?.equals(issueId)).toBe(true);
  });

  test("a report closes only once all its issues are settled", async () => {
    const [i1, i2] = [oid(), oid()];
    const r = report("accepted", i1);
    const w = world(
      [r],
      [
        [r._id, i1],
        [r._id, i2],
      ],
      [i2],
    );
    await followIssue(w.tx, change("moved", i2, "done"));
    expect(r.state).toBe("accepted");
    await followIssue(w.tx, change("moved", i1, "done"));
    expect(r.state).toBe("closed");
    expect(r.closedAt).toBeInstanceOf(Date);
    await followIssue(w.tx, change("moved", i1, "todo"));
    expect(r.state).toBe("accepted");
  });

  test("deleting the first issue moves the report's issueId to the next link", async () => {
    const [i1, i2] = [oid(), oid()];
    const r = report("accepted", i1);
    const w = world(
      [r],
      [
        [r._id, i1],
        [r._id, i2],
      ],
      [],
    );
    await followIssue(w.tx, change("deleted", i1, "todo"));
    expect(r.issueId?.equals(i2)).toBe(true);
    expect(w.rows).toHaveLength(1);
    expect(w.filesUpdates).toHaveLength(0);
  });

  test("a change on a report with no link touches no file", async () => {
    const w = world([], [], []);
    await followIssue(w.tx, change("moved", oid(), "done"));
    expect(w.filesUpdates).toHaveLength(0);
    expect(w.updates).toHaveLength(0);
  });

  test("deleting the last issue expires the report's files", async () => {
    const i1 = oid();
    const r = report("accepted", i1);
    const w = world([r], [[r._id, i1]], []);
    await followIssue(w.tx, change("deleted", i1, "todo"));
    expect(w.filesUpdates).toHaveLength(1);
  });
});

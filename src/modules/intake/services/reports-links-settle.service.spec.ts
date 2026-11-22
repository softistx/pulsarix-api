import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { Move, Statuses, world } from "~/notify";
import { reportOf } from "~/public-state";

const AddIssue = `mutation($id: ID!, $issues: [NewIssueFromReportInput!]!) {
  createIssuesFromClientReport(id: $id, issues: $issues) { issueIds }
}`;
const Unlink = `mutation($id: ID!, $issueId: ID!) {
  unlinkClientReport(id: $id, issueId: $issueId) { id state }
}`;

describe("unlinkClientReport settles the request", () => {
  test("unlinking the only open issue closes the request and mails the client once", async () => {
    const w = await world();
    try {
      const { reportId, issueId: done } = await w.accepted();
      const { createIssuesFromClientReport: made } = await w.kit.asOwner.call<{
        createIssuesFromClientReport: { issueIds: string[] };
      }>(AddIssue, { id: reportId, issues: [{ title: "Still open" }] });
      const open = made.issueIds.find((id) => id !== done) as string;
      const { project } = await w.kit.asOwner.call<{
        project: { statuses: { id: string; category: string }[] };
      }>(Statuses, { key: "ABC" });
      const status = project.statuses.find((s) => s.category === "done");
      await w.kit.asOwner.call(Move, { id: done, statusId: status?.id });
      // One issue is still open: the request stays accepted.
      expect((await reportOf(w.kit, reportId)).state).toBe("accepted");
      w.kit.mailer.clear();
      w.fake.jobs.clear();

      const { unlinkClientReport } = await w.kit.asOwner.call<{
        unlinkClientReport: { state: string };
      }>(Unlink, { id: reportId, issueId: open });
      expect(unlinkClientReport.state).toBe("closed");
      const stored = await w.mongo.db.clientReports.findById(
        new ObjectId(reportId),
      );
      expect(stored?.closedAt).toBeInstanceOf(Date);

      expect(await w.run(reportId)).toBe("sent");
      expect(await w.run(reportId)).toBe("nothing");
      expect(w.kit.mailer.sent).toHaveLength(1);
      expect(w.kit.mailer.sent[0]?.text).toContain("Resolved");
    } finally {
      w.restore();
    }
  });
});

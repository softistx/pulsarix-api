import { describe, expect, test } from "bun:test";
import { goodReport } from "~/intake";
import { world } from "~/notify";
import { Reply } from "~/requests-team";

describe("a team reply's e-mail", () => {
  test("goes to the reporter of that request only", async () => {
    const w = await world();
    try {
      // Two reporters whose requests share one issue.
      const a = await w.accepted({ email: "ada@client.test" });
      w.clearIp();
      const { body } = await w.kit.submit({
        ...goodReport({ email: "bob@client.test" }),
      });
      const b = (
        body as unknown as {
          data: { submitClientReport: { reportId: string } };
        }
      ).data.submitClientReport.reportId;
      await w.kit.intake.settled();
      await w.kit.asOwner.call(
        `mutation($id: ID!, $issueId: ID!) { linkClientReport(id: $id, issueId: $issueId) { id } }`,
        { id: b, issueId: a.issueId },
      );
      w.kit.mailer.clear();
      w.fake.jobs.clear();

      await w.kit.asOwner.call(Reply, {
        id: a.reportId,
        input: { body: "We look into it" },
      });
      const queued = [...w.fake.jobs.values()].map((job) => job.reportId);
      expect(queued).toEqual([a.reportId]);
      expect(await w.run(a.reportId)).toBe("sent");
      expect(w.kit.mailer.sent).toHaveLength(1);
      const mail = w.kit.mailer.sent[0];
      expect(JSON.stringify(mail?.to)).toContain("ada@client.test");
      expect(mail?.text).toContain("The team replied to your report");
      expect(JSON.stringify(w.kit.mailer.sent)).not.toContain(
        "bob@client.test",
      );
    } finally {
      w.restore();
    }
  });
});

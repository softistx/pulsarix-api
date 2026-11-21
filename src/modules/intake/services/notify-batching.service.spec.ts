import { describe, expect, test } from "bun:test";
import { goodReport, type IntakeKit } from "~/intake";
import { Decline, Move, Statuses, world } from "~/notify";
import { MAIL_DELAY_MS } from "./notify.service";

describe("the reporter's e-mails", () => {
  test("three replies in 10 minutes make one e-mail", async () => {
    const w = await world();
    try {
      const { reportId, issueId } = await w.accepted();
      await w.comment(issueId, "First reply", true);
      await w.comment(issueId, "Second reply", true);
      await w.comment(issueId, "Third reply", true);
      // One job, due 10 minutes after the first reply.
      expect(w.fake.jobs.size).toBe(1);
      expect(w.fake.delays).toEqual([
        MAIL_DELAY_MS,
        MAIL_DELAY_MS,
        MAIL_DELAY_MS,
      ]);
      expect([...w.fake.jobs.values()][0]).toEqual({
        organisationId: w.kit.organisation.id,
        reportId,
      });

      expect(await w.run(reportId)).toBe("sent");
      expect(w.kit.mailer.sent).toHaveLength(1);
      const mail = w.kit.mailer.sent[0];
      expect(mail?.subject).toContain("Alpha");
      // A tracking report: the replies are counted, the text stays on the page.
      expect(mail?.text).toContain("3 times");
      expect(mail?.text).not.toContain("First reply");
      expect(mail?.text).toMatch(/https:\/\/ui\.pulsarix\.test\/track\/\S+/);
      expect(mail?.text).toContain("/public/unsubscribe/");
      expect(mail?.headers?.["List-Unsubscribe"]).toContain(
        "/public/unsubscribe/",
      );
      expect(mail?.headers?.["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
      // Run again: nothing new, nothing sent.
      expect(await w.run(reportId)).toBe("nothing");
      expect(w.kit.mailer.sent).toHaveLength(1);
      // A reply after the batch is the next one.
      await w.comment(issueId, "Fourth reply", true);
      expect(await w.run(reportId)).toBe("sent");
      expect(w.kit.mailer.sent).toHaveLength(2);
    } finally {
      w.restore();
    }
  });

  test("an internal comment sends nothing", async () => {
    const w = await world();
    try {
      const { reportId, issueId } = await w.accepted();
      await w.comment(issueId, "Between us", false);
      expect(w.fake.jobs.size).toBe(0);
      expect(await w.run(reportId)).toBe("nothing");
      expect(w.kit.mailer.sent).toHaveLength(0);
    } finally {
      w.restore();
    }
  });

  test("a change of public state is mailed, with a decline's public reason", async () => {
    const w = await world();
    try {
      const { reportId, issueId } = await w.accepted();
      const { project } = await w.kit.asOwner.call<{
        project: { statuses: { id: string; category: string }[] };
      }>(Statuses, { key: "ABC" });
      const done = project.statuses.find((s) => s.category === "done");
      await w.kit.asOwner.call(Move, {
        id: issueId,
        statusId: done?.id,
      });
      expect(w.fake.jobs.size).toBe(1);
      expect(await w.run(reportId)).toBe("sent");
      expect(w.kit.mailer.sent[0]?.text).toContain("Resolved");
      expect(await w.run(reportId)).toBe("nothing");

      w.clearIp();
      const second = await w.accepted();
      void second;
      w.clearIp();
      const { body } = await w.kit.submit(
        goodReport({ email: "d@client.test", locale: "fr" }),
      );
      const declinedId = (
        body as unknown as {
          data: { submitClientReport: { reportId: string } };
        }
      ).data.submitClientReport.reportId;
      await w.kit.intake.settled();
      await w.kit.asOwner.call(Decline, {
        id: declinedId,
        reason: "Hors sujet",
      });
      expect(await w.run(declinedId)).toBe("sent");
      const mail = w.kit.mailer.sent.at(-1);
      expect(mail?.subject).toContain("Du nouveau");
      expect(mail?.text).toContain("Refusé");
      expect(mail?.text).toContain("Hors sujet");
    } finally {
      w.restore();
    }
  });
});

export type { IntakeKit };

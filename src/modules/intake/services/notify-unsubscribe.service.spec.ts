import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { goodReport } from "~/intake";
import { Accept, b64, Generate, world } from "~/notify";
import { UNSUBSCRIBE_PATH } from "../intake.unsubscribe";
import { IDENTITY_HEADER } from "./identity.service";
import { eraseReport } from "./retention.service";

describe("the reporter's e-mails", () => {
  test("unsubscribing stops the e-mails", async () => {
    const w = await world();
    try {
      const { reportId, issueId } = await w.accepted();
      await w.comment(issueId, "Before", true);
      expect(await w.run(reportId)).toBe("sent");
      const link = w.kit.mailer.sent[0]?.text.match(
        new RegExp(`${UNSUBSCRIBE_PATH}/(\\S+)`),
      )?.[1] as string;
      expect(link).toBeTruthy();
      const path = `https://api.pulsarix.test${UNSUBSCRIBE_PATH}/${link}`;

      // A forged token touches nothing; a GET only shows the button.
      const forged = await w.kit.kit.app.fetch(
        new Request(`${path}x`, { method: "POST" }),
      );
      expect(forged.status).toBe(404);
      const shown = await w.kit.kit.app.fetch(new Request(path));
      expect(shown.status).toBe(200);
      expect(await shown.text()).toContain("<form");
      expect(
        await w.mongo.db.clientReports.findFirst({ email: "r@client.test" }),
      ).toMatchObject({ emailsOff: false });

      const done = await w.kit.kit.app.fetch(
        new Request(path, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        }),
      );
      expect(done.status).toBe(200);
      expect(
        await w.mongo.db.clientReports.findFirst({ email: "r@client.test" }),
      ).toMatchObject({ emailsOff: true });

      // From now on: no job is scheduled and a job already waiting sends nothing.
      w.fake.jobs.clear();
      w.kit.mailer.clear();
      await w.comment(issueId, "After", true);
      expect(w.fake.jobs.size).toBe(0);
      expect(await w.run(reportId)).toBe("skipped");
      expect(w.kit.mailer.sent).toHaveLength(0);
    } finally {
      w.restore();
    }
  });

  test("an erased report gets no e-mail", async () => {
    const w = await world();
    try {
      const { reportId, issueId } = await w.accepted();
      const report = await w.mongo.db.clientReports.findFirst({
        email: "r@client.test",
      });
      await w.comment(issueId, "Pending", true);
      await eraseReport(w.mongo, report as NonNullable<typeof report>);
      expect(await w.run(reportId)).toBe("skipped");
      expect(w.kit.mailer.sent).toHaveLength(0);
      const after = await w.mongo.db.clientReports.findFirst({
        _id: (report as NonNullable<typeof report>)._id,
      });
      expect(after?.trackingTokenSealed).toBeNull();
    } finally {
      w.restore();
    }
  });

  test("an identified reporter reads the reply and lands on the host page; unsubscribing covers every request", async () => {
    const w = await world();
    try {
      const secret = (
        await w.kit.asOwner.call<{
          generateWidgetIdentitySecret: { secret: string };
        }>(Generate, { keyId: w.kit.key.id })
      ).generateWidgetIdentitySecret.secret;
      const iat = Math.floor(Date.now() / 1000);
      const payload = b64(
        JSON.stringify({
          sub: "u1",
          name: "Una",
          email: "una@client.test",
          aud: w.kit.key.publicKey,
          iat,
          exp: iat + 3600,
        }),
      );
      const token = `${payload}.${b64(createHmac("sha256", secret).update(payload).digest())}`;
      const ids: string[] = [];
      const issues: string[] = [];
      for (const n of [1, 2]) {
        w.clearIp();
        const { body } = await w.kit.submit(
          goodReport({
            title: `Mine ${n}`,
            pageUrl: `${w.kit.site}/settings`,
          }),
          { [IDENTITY_HEADER]: token },
        );
        ids.push(
          (
            body as unknown as {
              data: { submitClientReport: { reportId: string } };
            }
          ).data.submitClientReport.reportId,
        );
        const { acceptClientReport } = await w.kit.asOwner.call<{
          acceptClientReport: { issueId: string };
        }>(Accept, { id: ids.at(-1) });
        issues.push(acceptClientReport.issueId);
      }
      w.fake.jobs.clear();
      w.kit.mailer.clear();
      await w.comment(issues[0] as string, "Try again now", true);
      expect(await w.run(ids[0] as string)).toBe("sent");
      const mail = w.kit.mailer.sent[0];
      expect(mail?.to).toMatchObject({ address: "una@client.test" });
      expect(mail?.text).toContain("> Try again now");
      expect(mail?.text).toContain(`${w.kit.site}/settings`);
      expect(mail?.text).not.toContain("/track/");

      const link = mail?.text.match(
        new RegExp(`${UNSUBSCRIBE_PATH}/(\\S+)`),
      )?.[1] as string;
      await w.kit.kit.app.fetch(
        new Request(`https://api.pulsarix.test${UNSUBSCRIBE_PATH}/${link}`, {
          method: "POST",
        }),
      );
      await w.comment(issues[1] as string, "And this one", true);
      expect(await w.run(ids[1] as string)).toBe("skipped");
    } finally {
      w.restore();
    }
  });
});

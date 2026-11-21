import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { codeOfBody, goodReport, type IntakeKit, intakeKit } from "~/intake";
import { tenancy } from "../../../config/db";
import { SYSTEM_ACTOR } from "../../../core/shared/actors";
import { serverTicketSecret } from "../intake.server";
import type { ReporterMailDeps, ReporterMailJob } from "../intake.types";
import { UNSUBSCRIBE_PATH } from "../intake.unsubscribe";
import { unsubscribeSecret } from "../utils/mail.utils";
import { IDENTITY_HEADER } from "./identity.service";
import { MAIL_DELAY_MS, useReporterMailQueue } from "./notify.service";
import { sendReporterMail } from "./reporter-mail.service";
import { eraseReport } from "./retention.service";
import type { IntakeMongo } from "./submit.service";

// A19: the reporter's e-mails, batched and one-click unsubscribable (plan §19).

void codeOfBody;

const Generate = `mutation($keyId: ID!) {
  generateWidgetIdentitySecret(keyId: $keyId) { secret }
}`;
const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id issueId } }`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id }
}`;
const AddComment = `mutation($issueId: ID!, $input: AddCommentInput!) {
  addComment(issueId: $issueId, input: $input) { id }
}`;
const Statuses = `query($key: String!) {
  project(key: $key) { statuses { id name category } }
}`;
const Move = `mutation($id: ID!, $statusId: ID!) { moveIssue(id: $id, statusId: $statusId) { id } }`;

const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

// A queue that keeps what was added and refuses a second job with the same id,
// as @softistx/redis does for a job that is still waiting.
function fakeQueue() {
  const jobs = new Map<string, ReporterMailJob>();
  const delays: number[] = [];
  return {
    jobs,
    delays,
    queue: {
      async add(data: ReporterMailJob, options: { id: string; delay: number }) {
        delays.push(options.delay);
        if (jobs.has(options.id)) return { deduplicated: true };
        jobs.set(options.id, data);
        return { deduplicated: false };
      },
    },
  };
}

async function world() {
  const kit = await intakeKit();
  const fake = fakeQueue();
  const restore = useReporterMailQueue(fake.queue);
  const mongo = (await tenancy.databaseOf(kit.organisation.id)).as(
    SYSTEM_ACTOR,
  ) as unknown as IntakeMongo;
  const deps = (): ReporterMailDeps => ({
    mongo: async () => mongo,
    mailer: kit.mailer,
    from: { name: "pulsarix", address: "noreply@pulsarix.test" },
    uiOrigin: "https://ui.pulsarix.test",
    allowedOrigins: async () => [kit.site],
    secret: unsubscribeSecret(serverTicketSecret()),
  });
  const clearIp = () =>
    (
      kit.limits as unknown as { intakeIpKey: { counts: Map<string, number> } }
    ).intakeIpKey.counts.clear();
  // A report with an e-mail, accepted into an issue. Mails sent so far are
  // forgotten: the tracking e-mail is not what is under test.
  const accepted = async (extra: Record<string, unknown> = {}) => {
    clearIp();
    const { body } = await kit.submit(
      goodReport({ email: "r@client.test", ...extra }),
    );
    const reportId = (
      body as unknown as {
        data: { submitClientReport: { reportId: string } };
      }
    ).data.submitClientReport.reportId;
    await kit.intake.settled();
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: reportId });
    kit.mailer.clear();
    fake.jobs.clear();
    fake.delays.length = 0;
    return { reportId, issueId: acceptClientReport.issueId };
  };
  const comment = (issueId: string, body: string, isPublic: boolean) =>
    kit.asOwner.call(AddComment, {
      issueId,
      input: { body, public: isPublic },
    });
  const run = (reportId: string) =>
    sendReporterMail(deps(), {
      organisationId: kit.organisation.id,
      reportId,
    });
  return { kit, fake, mongo, deps, accepted, comment, run, restore, clearIp };
}

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

  // A signed identity token of the world's key; `claims` replace the defaults.
  const identityToken = async (
    w: Awaited<ReturnType<typeof world>>,
    claims: Record<string, unknown>,
  ) => {
    const secret = (
      await w.kit.asOwner.call<{
        generateWidgetIdentitySecret: { secret: string };
      }>(Generate, { keyId: w.kit.key.id })
    ).generateWidgetIdentitySecret.secret;
    const iat = Math.floor(Date.now() / 1000);
    const payload = b64(
      JSON.stringify({
        sub: "u1",
        aud: w.kit.key.publicKey,
        iat,
        exp: iat + 3600,
        ...claims,
      }),
    );
    return `${payload}.${b64(createHmac("sha256", secret).update(payload).digest())}`;
  };

  test("the e-mail links only a page of an allowed origin", async () => {
    const w = await world();
    try {
      const token = await identityToken(w, { email: "una@client.test" });
      const ids: string[] = [];
      const issues: string[] = [];
      for (const pageUrl of ["https://evil.test/phish", `${w.kit.site}/ok`]) {
        w.clearIp();
        const { body } = await w.kit.submit(goodReport({ pageUrl }), {
          [IDENTITY_HEADER]: token,
        });
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
      w.kit.mailer.clear();
      await w.comment(issues[0] as string, "Reply one", true);
      expect(await w.run(ids[0] as string)).toBe("sent");
      expect(w.kit.mailer.sent[0]?.text).not.toContain("evil.test");
      w.kit.mailer.clear();
      await w.comment(issues[1] as string, "Reply two", true);
      expect(await w.run(ids[1] as string)).toBe("sent");
      expect(w.kit.mailer.sent[0]?.text).toContain(`${w.kit.site}/ok`);
    } finally {
      w.restore();
    }
  });

  test("an identified token without an e-mail claim never mails the form's address", async () => {
    const w = await world();
    try {
      const token = await identityToken(w, {});
      const { body } = await w.kit.submit(
        goodReport({ email: "victim@client.test" }),
        { [IDENTITY_HEADER]: token },
      );
      const reportId = (
        body as unknown as {
          data: { submitClientReport: { reportId: string } };
        }
      ).data.submitClientReport.reportId;
      await w.kit.intake.settled();
      expect(w.kit.mailer.sent).toHaveLength(0);
      const report = await w.mongo.db.clientReports.findById(
        new ObjectId(reportId),
      );
      expect(report?.email).toBeNull();
    } finally {
      w.restore();
    }
  });
});

export type { IntakeKit };

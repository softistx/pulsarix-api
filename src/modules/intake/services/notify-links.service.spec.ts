import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { goodReport } from "~/intake";
import { Accept, b64, Generate, world } from "~/notify";
import { IDENTITY_HEADER } from "./identity.service";

describe("the reporter's e-mails", () => {
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

import { describe, expect, test } from "bun:test";
import { codeOfBody, goodReport, intakeKit } from "~/intake";
import { Accept, AddComment, Decline, type Report, Reports } from "~/reports";

describe("the tracking page shows public replies only", () => {
  test("state and public replies; no private comment, author, issue or mention id", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ email: "reporter@client.test" }));
    await kit.intake.settled();
    const token = kit.mailer.sent[0]?.text.match(
      /\/track\/(\S+)/,
    )?.[1] as string;

    const received = await kit.track(token);
    expect(received.response.status).toBe(200);
    expect(received.body?.data).toMatchObject({
      clientReportStatus: {
        state: "new",
        title: "The save button does nothing",
        replies: [],
      },
    });
    expect(received.response.headers.get("referrer-policy")).toBe(
      "no-referrer",
    );
    expect(received.response.headers.get("x-robots-tag")).toBe("noindex");
    expect(received.response.headers.get("cache-control")).toBe("no-store");

    const list = await kit.asOwner.call<{ clientReports: { nodes: Report[] } }>(
      Reports,
      { projectId: kit.project.id },
    );
    const reportId = list.clientReports.nodes[0]?.id as string;
    const { acceptClientReport } = await kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, {
      id: reportId,
    });
    await kit.asOwner.call(AddComment, {
      issueId: acceptClientReport.issueId,
      input: { body: "Internal: the cause is the cache", public: false },
    });
    await kit.asOwner.call(AddComment, {
      issueId: acceptClientReport.issueId,
      input: {
        body: `Thanks, fixing it. cc @[Steve](${kit.owner.id})`,
        public: true,
      },
    });
    const tracked = await kit.track(token);
    const data = tracked.body?.data as unknown as {
      clientReportStatus: {
        state: string;
        replies: { at: string; body: string }[];
      };
    };
    expect(data.clientReportStatus.state).toBe("accepted");
    expect(data.clientReportStatus.replies).toHaveLength(1);
    expect(data.clientReportStatus.replies[0]?.body).toBe(
      "Thanks, fixing it. cc @Steve",
    );
    const text = JSON.stringify(tracked.body);
    expect(text).not.toContain("Internal");
    expect(text).not.toContain(kit.owner.id);
    expect(text).not.toContain(acceptClientReport.issueId);
    expect(text).not.toContain("authorId");
  });

  test("a declined report shows its state and the reason the team wrote for it (A15)", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ email: "reporter@client.test" }));
    await kit.intake.settled();
    const token = kit.mailer.sent[0]?.text.match(
      /\/track\/(\S+)/,
    )?.[1] as string;
    const list = await kit.asOwner.call<{ clientReports: { nodes: Report[] } }>(
      Reports,
      { projectId: kit.project.id },
    );
    await kit.asOwner.call(Decline, {
      id: list.clientReports.nodes[0]?.id,
      reason: "Not planned, sorry",
    });
    const tracked = await kit.track(token);
    expect(tracked.body?.data).toMatchObject({
      clientReportStatus: {
        state: "declined",
        publicState: "declined",
        declineReason: "Not planned, sorry",
      },
    });
  });

  test("it is for the UI server: a browser origin, a missing client header, a bad or foreign token are refused", async () => {
    const kit = await intakeKit();
    await kit.submit(goodReport({ email: "reporter@client.test" }));
    await kit.intake.settled();
    const token = kit.mailer.sent[0]?.text.match(
      /\/track\/(\S+)/,
    )?.[1] as string;
    const fromBrowser = await kit.op(
      "clientReportStatus",
      { token },
      { "x-pulsarix-client": "x" },
    );
    expect(fromBrowser.response.status).toBe(403);
    expect(
      fromBrowser.response.headers.get("access-control-allow-origin"),
    ).toBeNull();
    const noHeader = await kit.op(
      "clientReportStatus",
      { token },
      { origin: null },
    );
    expect(noHeader.response.status).toBe(403);
    const secret = token.split(".")[1] as string;
    const other = await intakeKit();
    for (const bad of [
      "",
      "nonsense",
      `${kit.organisation.id}.${"A".repeat(43)}`,
      `${other.organisation.id}.${secret}`,
      `${kit.organisation.id}.${secret}.extra`,
      `${"0".repeat(24)}.${secret}`,
    ]) {
      const { response, body } = await kit.track(bad);
      expect(response.status).toBe(404);
      expect(codeOfBody(body)).toBe("intake.errors.not-found");
    }
  });
});

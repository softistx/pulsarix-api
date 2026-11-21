import { describe, expect, test } from "bun:test";
import { Collection } from "mongodb";
import { codeOf } from "~/http";
import { goodReport } from "~/intake";
import { pdf, setup, shot, useMediaS3 } from "~/reports-triage";
import { tenancy } from "../../../config/db";
import { TICKET_HEADER } from "../utils/tickets.utils";
import type { purgeReportFiles } from "./files-retention.service";

useMediaS3();

describe("the pending files of a report", () => {
  const Pending = `query($projectId: ID!) {
    clientReports(projectId: $projectId) { nodes { id pendingFiles files { id } } }
  }`;
  const pendingOf = async (w: Awaited<ReturnType<typeof setup>>) =>
    (
      await w.kit.asOwner.call<{
        clientReports: {
          nodes: { id: string; pendingFiles: number; files: unknown[] }[];
        };
      }>(Pending, { projectId: w.kit.project.id })
    ).clientReports.nodes;

  const byId = (rows: Awaited<ReturnType<typeof pendingOf>>, id: string) =>
    rows.find((row) => row.id === id);

  async function submitWithSlots(w: Awaited<ReturnType<typeof setup>>) {
    const one = await w.kit.submit(
      goodReport({
        files: [
          {
            role: "screenshot",
            name: "a.png",
            type: "image/png",
            size: shot.length,
          },
          {
            role: "file",
            name: "b.pdf",
            type: "application/pdf",
            size: pdf.length,
          },
        ],
      }),
    );
    (
      w.kit.limits as unknown as {
        intakeIpKey: { counts: Map<string, number> };
      }
    ).intakeIpKey.counts.clear();
    const two = await w.kit.submit(goodReport());
    const sent = (
      (one.body as { data: unknown }).data as unknown as {
        submitClientReport: {
          reportId: string;
          files: { slot: string; ticket: string }[];
        };
      }
    ).submitClientReport;
    const plain = (
      (two.body as { data: unknown }).data as unknown as {
        submitClientReport: { reportId: string };
      }
    ).submitClientReport.reportId;
    return { sent, plain };
  }

  test("counts the slots whose bytes have not arrived, per report", async () => {
    const w = await setup();
    const { sent, plain } = await submitWithSlots(w);

    const before = await pendingOf(w);
    expect(byId(before, sent.reportId)).toMatchObject({
      pendingFiles: 2,
      files: [],
    });
    expect(byId(before, plain)?.pendingFiles).toBe(0);
  }, 120_000);

  test("a stored upload is no longer pending", async () => {
    const w = await setup();
    const { sent } = await submitWithSlots(w);

    const [first] = sent.files;
    const answer = await w.kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${first?.slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "content-length": String(shot.length),
            [TICKET_HEADER]: first?.ticket as string,
            origin: w.kit.site,
          },
          body: shot as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(answer.status).toBe(200);
    const during = await pendingOf(w);
    expect(byId(during, sent.reportId)).toMatchObject({ pendingFiles: 1 });
    expect(byId(during, sent.reportId)?.files).toHaveLength(1);
  }, 120_000);

  test("an expired slot is dropped, and a viewer is refused", async () => {
    const w = await setup();
    const { sent } = await submitWithSlots(w);

    const mongo = (await tenancy.databaseOf(
      w.kit.organisation.id,
    )) as unknown as Parameters<typeof purgeReportFiles>[0];
    await mongo.db.clientReportFiles.raw.updateMany(
      { state: "pending" },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(byId(await pendingOf(w), sent.reportId)?.pendingFiles).toBe(0);

    // A viewer does not triage: the inbox, and so the field, is refused.
    expect(
      codeOf(
        await w
          .as(w.viewer.token)
          .attempt(Pending, { projectId: w.kit.project.id }),
      ),
    ).toBe("auth.errors.forbidden");
  }, 120_000);
});

describe("the pending files of a page of reports", () => {
  test("one aggregate serves the whole page, not one per report", async () => {
    const w = await setup();
    const reports: string[] = [];
    for (let n = 0; n < 4; n++) {
      const sent = await w.kit.submit(
        goodReport({
          files: [
            {
              role: "file",
              name: "b.pdf",
              type: "application/pdf",
              size: pdf.length,
            },
          ],
        }),
      );
      (
        w.kit.limits as unknown as {
          intakeIpKey: { counts: Map<string, number> };
        }
      ).intakeIpKey.counts.clear();
      reports.push(
        (
          (sent.body as { data: unknown }).data as unknown as {
            submitClientReport: { reportId: string };
          }
        ).submitClientReport.reportId,
      );
    }
    // Counted on the driver's collection, whatever wrapper the request uses.
    const proto = Collection.prototype as unknown as {
      aggregate: (...args: unknown[]) => unknown;
    };
    const aggregate = proto.aggregate;
    let aggregates = 0;
    proto.aggregate = function (this: Collection, ...args: unknown[]) {
      if (this.collectionName === "clientReportFiles") aggregates += 1;
      return aggregate.apply(this, args);
    };
    let nodes: { id: string; pendingFiles: number }[];
    try {
      nodes = (
        await w.kit.asOwner.call<{
          clientReports: { nodes: { id: string; pendingFiles: number }[] };
        }>(
          `query($projectId: ID!) { clientReports(projectId: $projectId) { nodes { id pendingFiles } } }`,
          { projectId: w.kit.project.id },
        )
      ).clientReports.nodes;
    } finally {
      proto.aggregate = aggregate;
    }
    expect(nodes.filter((n) => reports.includes(n.id))).toHaveLength(4);
    expect(nodes.every((n) => n.pendingFiles === 1)).toBe(true);
    expect(aggregates).toBe(1);
  }, 120_000);
});

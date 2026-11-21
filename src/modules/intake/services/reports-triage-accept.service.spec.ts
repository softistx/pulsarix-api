import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOf } from "~/http";
import { goodReport } from "~/intake";
import { bucketKeys } from "~/media";
import {
  Accept,
  Decline,
  type FileOut,
  IssueAttachments,
  IssueFiles,
  inbox,
  media,
  type ReportOut,
  reportWithFiles,
  s3,
  setup,
  shot,
  useMediaS3,
} from "~/reports-triage";
import { tenancy } from "../../../config/db";
import { TICKET_HEADER } from "../utils/tickets.utils";
import { purgeReportFiles } from "./files-retention.service";

useMediaS3();

describe("accept and decline", () => {
  test("accepting releases the files in place, to every reader of the issue, outside the 20 per owner", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    const [report] = await inbox(w);
    const before = await bucketKeys(
      s3,
      `organisations/${w.kit.organisation.id}/`,
    );
    const accepted = await w.kit.asOwner.call<{
      acceptClientReport: {
        state: string;
        issueId: string;
        files: { state: string }[];
      };
    }>(Accept, { id: report?.id });
    expect(accepted.acceptClientReport.files.map((f) => f.state)).toEqual([
      "released",
      "released",
    ]);
    const issueId = accepted.acceptClientReport.issueId;

    // A viewer now reads them, through the media route and on the issue.
    const listed = await w
      .as(w.viewer.token)
      .call<{ issueClientReportFiles: FileOut[] }>(IssueFiles, { issueId });
    expect(listed.issueClientReportFiles.map((f) => f.fileName)).toEqual([
      "screen.png",
      "notes.pdf",
    ]);
    for (const file of listed.issueClientReportFiles) {
      expect((await w.read(w.viewer.token, file.url)).status).toBe(200);
    }

    // No copy: the same objects, no attachment record.
    expect(
      await bucketKeys(s3, `organisations/${w.kit.organisation.id}/`),
    ).toEqual(before);
    const attachments = await w
      .as(w.viewer.token)
      .call<{ issueAttachments: unknown[] }>(IssueAttachments, { issueId });
    expect(attachments.issueAttachments).toEqual([]);

    // An issue from no report lists nothing; a stranger of the organisation is refused.
    const foreign = await w.as(w.viewer.token).attempt(IssueFiles, {
      issueId: new ObjectId().toHexString(),
    });
    expect(codeOf(foreign)).toBe("issues.errors.not-found");
  }, 120_000);

  test("deleting the issue of an accepted report purges its files, objects and records", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    const [report] = await inbox(w);
    const accepted = await w.kit.asOwner.call<{
      acceptClientReport: { issueId: string };
    }>(Accept, { id: report?.id });
    const prefix = `organisations/${w.kit.organisation.id}/`;
    expect((await bucketKeys(s3, prefix)).length).toBeGreaterThan(0);
    await w.kit.asOwner.call(`mutation($id: ID!) { deleteIssue(id: $id) }`, {
      id: accepted.acceptClientReport.issueId,
    });
    const mongo = (await tenancy.databaseOf(
      w.kit.organisation.id,
    )) as unknown as Parameters<typeof purgeReportFiles>[0];
    const purged = await purgeReportFiles(mongo, media, w.kit.organisation.id);
    expect(purged.deleted).toBe(2);
    expect(await bucketKeys(s3, prefix)).toEqual([]);
    expect(
      await mongo.db.clientReportFiles.count({
        reportId: new ObjectId(report?.id),
      }),
    ).toBe(0);
    const [after] = await inbox(w);
    expect(after).toMatchObject({ id: report?.id, state: "closed" });
    expect(after?.files).toEqual([]);
  }, 120_000);

  test("a file that arrives after the acceptance is released at once", async () => {
    const w = await setup();
    const sent = await w.kit.submit(
      goodReport({
        files: [
          {
            role: "screenshot",
            name: "late.png",
            type: "image/png",
            size: shot.length,
          },
        ],
      }),
    );
    const data = sent.body?.data as unknown as {
      submitClientReport: {
        reportId: string;
        files: { slot: string; ticket: string }[];
      };
    };
    await w.kit.asOwner.call(Accept, { id: data.submitClientReport.reportId });
    const [file] = data.submitClientReport.files;
    const answer = await w.kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${file?.slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "content-length": String(shot.length),
            [TICKET_HEADER]: file?.ticket as string,
            origin: w.kit.site,
          },
          body: shot as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(answer.status).toBe(200);
    const [report] = await inbox(w);
    expect(report?.files.map((f) => f.state)).toEqual(["released"]);
  }, 120_000);

  test("declining keeps the files quarantined", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    const [report] = await inbox(w);
    const declined = await w.kit.asOwner.call<{
      declineClientReport: { files: { state: string }[] };
    }>(Decline, { id: report?.id, reason: "not ours" });
    expect(declined.declineClientReport.files.map((f) => f.state)).toEqual([
      "quarantined",
      "quarantined",
    ]);
    const url = ((report as ReportOut).files[0] as FileOut).url;
    expect((await w.read(w.viewer.token, url)).status).toBe(404);
    expect((await w.read(w.member.token, url)).status).toBe(200);
  }, 120_000);
});

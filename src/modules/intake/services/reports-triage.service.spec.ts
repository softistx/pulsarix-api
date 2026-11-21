import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { Collection, ObjectId } from "mongodb";
import { memberWith } from "~/auth";
import { codeOf } from "~/http";
import { goodReport, type IntakeKit, intakeKit } from "~/intake";
import {
  bucketKeys,
  call,
  errorOf,
  onePagePdf,
  png,
  startMediaS3,
} from "~/media";
import { coreMongo, tenancy } from "../../../config/db";
import { clientHeader } from "../../../http/csrf";
import { TRACKING_HEADER } from "../intake.http";
import { TICKET_HEADER } from "../utils/tickets.utils";
import { purgeReportFiles } from "./files-retention.service";

// A13: the team reads a report's files (quarantined, then released), accept
// and decline decide where they go, the reporter reads thumbnails of their own
// pictures, and the widget key counts the file traffic.
let s3: TestS3;
let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const shot = png(64, 48);
const pdf = onePagePdf();

const Reports = `query($projectId: ID!) {
  clientReports(projectId: $projectId) {
    nodes { id state files { id reportId role fileName mime size state width height url previewUrl } }
  }
}`;
const Accept = `mutation($id: ID!) { acceptClientReport(id: $id) { id state issueId files { id state } } }`;
const Decline = `mutation($id: ID!, $reason: String!) {
  declineClientReport(id: $id, reason: $reason) { id state files { id state } }
}`;
const IssueFiles = `query($issueId: ID!) {
  issueClientReportFiles(issueId: $issueId) { id state fileName url previewUrl }
}`;
const IssueAttachments = `query($issueId: ID!) { issueAttachments(issueId: $issueId) { id } }`;
const Keys = `query($projectId: ID!) {
  widgetKeys(projectId: $projectId) { id uploads refusals { reason count } }
}`;

interface FileOut {
  id: string;
  state: string;
  fileName: string;
  mime: string;
  url: string;
  previewUrl: string | null;
}
interface ReportOut {
  id: string;
  state: string;
  files: FileOut[];
}

// A report with a screenshot and a PDF, both stored; the reporter gave an
// e-mail, so a tracking token was mailed.
async function reportWithFiles(kit: IntakeKit) {
  const sent = await kit.submit(
    goodReport({
      email: "reporter@client.test",
      files: [
        {
          role: "screenshot",
          name: "screen.png",
          type: "image/png",
          size: shot.length,
        },
        {
          role: "file",
          name: "notes.pdf",
          type: "application/pdf",
          size: pdf.length,
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
  const { reportId, files } = data.submitClientReport;
  const bytes = [shot, pdf];
  const types = ["image/png", "application/pdf"];
  for (const [index, file] of files.entries()) {
    const answer = await kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${file.slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": types[index] as string,
            "content-length": String(bytes[index]?.length),
            [TICKET_HEADER]: file.ticket,
            origin: kit.site,
          },
          body: bytes[index] as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(answer.status).toBe(200);
  }
  await kit.intake.settled();
  const mail = kit.mailer.sent.at(-1);
  const token = mail?.text.match(/\/track\/(\S+)/)?.[1] as string;
  return { reportId, token };
}

const setup = async () => {
  const kit = await intakeKit({ media });
  const viewer = await memberWith(
    kit.kit,
    kit.organisation.id,
    kit.owner.token,
    "viewer",
  );
  const member = await memberWith(
    kit.kit,
    kit.organisation.id,
    kit.owner.token,
    "member",
  );
  const as = (token: string) =>
    kit.kit.client(token, { organisation: kit.organisation.id });
  const read = (token: string | null, path: string) =>
    call(kit.kit.app, path, {
      token,
      organisation: kit.organisation.id,
    });
  return { kit, viewer, member, as, read };
};

const inbox = async (w: Awaited<ReturnType<typeof setup>>) => {
  const read = await w.kit.asOwner.call<{
    clientReports: { nodes: ReportOut[] };
  }>(Reports, { projectId: w.kit.project.id });
  return read.clientReports.nodes;
};

const trackedRead = (
  kit: IntakeKit,
  path: string,
  token: string,
  headers: Record<string, string> = {},
) =>
  kit.kit.app.fetch(
    new Request(`https://api.pulsarix.test${path}`, {
      headers: {
        [clientHeader]: "pulsarix-ui",
        [TRACKING_HEADER]: token,
        ...headers,
      },
    }),
  );

describe("the team reads a quarantined file", () => {
  test("those who triage read it through the media route; a viewer does not", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    const [report] = await inbox(w);
    expect(report?.files.map((f) => [f.fileName, f.state])).toEqual([
      ["screen.png", "quarantined"],
      ["notes.pdf", "quarantined"],
    ]);
    const [picture, document] = (report as ReportOut).files;
    expect(picture?.url).toMatch(
      /^\/media\/report-files\/[0-9a-f-]{36}\/full$/,
    );
    expect(picture?.previewUrl).toMatch(/\/256$/);
    expect(document?.url).toMatch(/\/file$/);

    // A member writes issues: they triage.
    const asMember = await w.read(w.member.token, picture?.url as string);
    expect(asMember.status).toBe(200);
    expect(asMember.headers.get("content-type")).toBe("image/webp");
    const thumb = await w.read(w.member.token, picture?.previewUrl as string);
    expect(thumb.status).toBe(200);
    // A PDF is a download.
    const download = await w.read(w.kit.owner.token, document?.url as string);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");

    // A viewer reads issues, not the inbox: the file is 404 for them, and the
    // field is refused.
    const asViewer = await w.read(w.viewer.token, picture?.url as string);
    expect(asViewer.status).toBe(404);
    expect((await errorOf(asViewer)).extensions["code"]).toBe(
      "intake.errors.file-not-found",
    );
    expect(
      codeOf(
        await w
          .as(w.viewer.token)
          .attempt(Reports, { projectId: w.kit.project.id }),
      ),
    ).toBe("auth.errors.forbidden");
  }, 120_000);

  test("no session, no client header, a size the file lacks and a stranger are all refused", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    const [report] = await inbox(w);
    const [picture, document] = (report as ReportOut).files;
    expect((await w.read(null, picture?.url as string)).status).toBe(401);
    const noClient = await call(w.kit.kit.app, picture?.url as string, {
      token: w.kit.owner.token,
      organisation: w.kit.organisation.id,
      client: false,
    });
    expect(noClient.status).toBe(403);
    // The picture has no `file` size, the PDF no `full`; there is no bare key.
    const key = (picture as FileOut).url.split("/")[3];
    expect(
      (await w.read(w.kit.owner.token, `/media/report-files/${key}/file`))
        .status,
    ).toBe(404);
    expect(
      (
        await w.read(
          w.kit.owner.token,
          (document as FileOut).url.replace("/file", "/full"),
        )
      ).status,
    ).toBe(404);
    expect(
      (await w.read(w.kit.owner.token, `/media/report-files/${key}`)).status,
    ).toBe(404);
    // The upload route of the kind is not mounted for the team.
    const put = await call(w.kit.kit.app, `/media/report-files/${key}/full`, {
      method: "PUT",
      token: w.kit.owner.token,
      organisation: w.kit.organisation.id,
      body: shot as unknown as BodyInit,
    });
    expect(put.status).toBe(405);
  }, 120_000);
});

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

  test("counts the slots whose bytes have not arrived, per report, and drops them once stored or expired", async () => {
    const w = await setup();
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

    const before = await pendingOf(w);
    const byId = (rows: typeof before, id: string) =>
      rows.find((row) => row.id === id);
    expect(byId(before, sent.reportId)).toMatchObject({
      pendingFiles: 2,
      files: [],
    });
    expect(byId(before, plain)?.pendingFiles).toBe(0);

    // One upload arrives: stored, no longer pending.
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

    // The other slot expires: nothing is awaited any more.
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

describe("the reporter's own thumbnails", () => {
  test("the status lists the files; the tracking token reads a picture's thumbnail only", async () => {
    const w = await setup();
    const { token } = await reportWithFiles(w.kit);
    const tracked = await w.kit.track(token);
    const files = (
      (tracked.body as { data: unknown }).data as unknown as {
        clientReportStatus: {
          files: {
            id: string;
            role: string;
            name: string;
            thumbnailUrl: string | null;
          }[];
        };
      }
    ).clientReportStatus.files;
    expect(files.map((f) => [f.name, f.thumbnailUrl === null])).toEqual([
      ["screen.png", false],
      ["notes.pdf", true],
    ]);
    const [picture, document] = files;
    expect(picture?.thumbnailUrl).toBe(`/public/tracking/files/${picture?.id}`);

    const thumb = await trackedRead(
      w.kit,
      picture?.thumbnailUrl as string,
      token,
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(thumb.headers.get("cache-control")).toBe("no-store");
    expect(thumb.headers.get("x-content-type-options")).toBe("nosniff");
    expect(thumb.headers.get("referrer-policy")).toBe("no-referrer");
    expect(thumb.headers.get("x-robots-tag")).toBe("noindex");
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // The thumbnail is the 256 rendition the team reads, byte for byte.
    const [stored] = await inbox(w).then((r) => r[0]?.files as FileOut[]);
    const preview = await w.read(
      w.kit.owner.token,
      stored?.previewUrl as string,
    );
    expect(bytes).toEqual(new Uint8Array(await preview.arrayBuffer()));

    // A PDF has no thumbnail for the reporter, and no other size or route reads.
    expect(
      (
        await trackedRead(
          w.kit,
          `/public/tracking/files/${document?.id}`,
          token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await trackedRead(
          w.kit,
          `/public/tracking/files/${picture?.id}/full`,
          token,
        )
      ).status,
    ).toBe(404);
    expect((await w.read(null, (stored as FileOut).url)).status).toBe(401);

    // UI server only, with the token.
    expect(
      (
        await trackedRead(w.kit, picture?.thumbnailUrl as string, token, {
          origin: w.kit.site,
        })
      ).status,
    ).toBe(403);
    const noClient = await w.kit.kit.app.fetch(
      new Request(`https://api.pulsarix.test${picture?.thumbnailUrl}`, {
        headers: { [TRACKING_HEADER]: token },
      }),
    );
    expect(noClient.status).toBe(403);
    const noToken = await w.kit.kit.app.fetch(
      new Request(`https://api.pulsarix.test${picture?.thumbnailUrl}`, {
        headers: { [clientHeader]: "pulsarix-ui" },
      }),
    );
    expect(noToken.status).toBe(404);
    expect(
      (await trackedRead(w.kit, picture?.thumbnailUrl as string, "x.y")).status,
    ).toBe(404);
  }, 120_000);

  test("another report's token reads none of these files", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    const [mine] = await inbox(w);
    const other = await w.kit.submit(
      goodReport({ email: "other@client.test" }),
    );
    expect(other.response.status).toBe(200);
    await w.kit.intake.settled();
    const otherToken = w.kit.mailer.sent
      .at(-1)
      ?.text.match(/\/track\/(\S+)/)?.[1] as string;
    const tracked = await w.kit.track(otherToken);
    expect(
      (
        (tracked.body as { data: unknown }).data as unknown as {
          clientReportStatus: { files: unknown[] };
        }
      ).clientReportStatus.files,
    ).toEqual([]);
    const id = ((mine as ReportOut).files[0] as FileOut).id;
    expect(
      (await trackedRead(w.kit, `/public/tracking/files/${id}`, otherToken))
        .status,
    ).toBe(404);
  }, 120_000);

  test("after the erasure the thumbnails are gone", async () => {
    const w = await setup();
    const { token } = await reportWithFiles(w.kit);
    const tracked = await w.kit.track(token);
    const id = (
      (tracked.body as { data: unknown }).data as unknown as {
        clientReportStatus: { files: { id: string }[] };
      }
    ).clientReportStatus.files[0]?.id;
    const mongo = (await tenancy.databaseOf(
      w.kit.organisation.id,
    )) as never as {
      db: {
        clientReports: {
          raw: { updateMany: (f: object, u: object) => Promise<unknown> };
        };
      };
    };
    await mongo.db.clientReports.raw.updateMany(
      {},
      { $set: { erasedAt: new Date(), trackingTokenHash: null } },
    );
    expect((await w.kit.track(token)).response.status).toBe(404);
    expect(
      (await trackedRead(w.kit, `/public/tracking/files/${id}`, token)).status,
    ).toBe(404);
  }, 120_000);
});

describe("the key counts its file traffic", () => {
  test("uploads and refusals by reason", async () => {
    const w = await setup();
    await reportWithFiles(w.kit);
    // A file declared with a type the kind refuses is counted; so is a wrong upload.
    await w.kit.submit(
      goodReport({
        files: [{ role: "file", name: "a.gif", type: "image/gif", size: 10 }],
      }),
    );
    await w.kit.intake.settled();
    const sent = await w.kit.submit(
      goodReport({
        files: [
          {
            role: "screenshot",
            name: "s.png",
            type: "image/png",
            size: shot.length,
          },
        ],
      }),
    );
    const ticket = (
      (sent.body as { data: unknown }).data as unknown as {
        submitClientReport: { files: { slot: string; ticket: string }[] };
      }
    ).submitClientReport.files[0];
    const wrong = await w.kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${ticket?.slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(shot.length),
            [TICKET_HEADER]: ticket?.ticket as string,
            origin: w.kit.site,
          },
          body: shot as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(wrong.status).toBe(400);
    // The bytes are not a JPEG: the kind refuses them, and that is counted too.
    const liar = await w.kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${ticket?.slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "content-length": String(shot.length),
            [TICKET_HEADER]: ticket?.ticket as string,
            origin: w.kit.site,
          },
          body: new Uint8Array(shot.length) as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
    expect(liar.status).toBe(415);
    await w.kit.intake.settled();
    const keys = await w.kit.asOwner.call<{
      widgetKeys: {
        uploads: number;
        refusals: { reason: string; count: number }[];
      }[];
    }>(Keys, { projectId: w.kit.project.id });
    const [key] = keys.widgetKeys;
    expect(key?.uploads).toBe(2);
    expect(key?.refusals).toEqual(
      expect.arrayContaining([
        { reason: "file-unsupported-type", count: 2 },
        { reason: "upload-mismatch", count: 1 },
      ]),
    );
    expect(key?.refusals.every((r) => r.count > 0)).toBe(true);
    // The count is on the key alone.
    const stored = await coreMongo.db.widgetKeys.findById(
      new ObjectId(w.kit.key.id),
    );
    expect(stored?.uploads).toBe(2);
  }, 120_000);

  test("a key with files off counts the refusal", async () => {
    const w = await setup();
    await w.kit.asOwner.call(
      `mutation($id: ID!) { updateWidgetKey(id: $id, input: { attachmentsEnabled: false }) { id } }`,
      { id: w.kit.key.id },
    );
    const sent = await w.kit.submit(
      goodReport({
        files: [
          {
            role: "screenshot",
            name: "s.png",
            type: "image/png",
            size: shot.length,
          },
        ],
      }),
    );
    expect(sent.response.status).toBe(403);
    await w.kit.intake.settled();
    const keys = await w.kit.asOwner.call<{
      widgetKeys: { refusals: { reason: string; count: number }[] }[];
    }>(Keys, { projectId: w.kit.project.id });
    expect(keys.widgetKeys[0]?.refusals).toEqual([
      { reason: "attachments-disabled", count: 1 },
    ]);
  }, 120_000);
});

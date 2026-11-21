import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { codeOf } from "~/http";
import { goodReport } from "~/intake";
import { call, errorOf } from "~/media";
import {
  type FileOut,
  inbox,
  Keys,
  type ReportOut,
  Reports,
  reportWithFiles,
  setup,
  shot,
  useMediaS3,
} from "~/reports-triage";
import { coreMongo } from "../../../config/db";
import { TICKET_HEADER } from "../utils/tickets.utils";

useMediaS3();

// A13: the team reads a report's files (quarantined, then released), accept
// and decline decide where they go, the reporter reads thumbnails of their own

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

async function putSlot(
  w: Awaited<ReturnType<typeof setup>>,
  ticket: { slot: string; ticket: string } | undefined,
  type: string,
  body: Uint8Array,
) {
  return w.kit.kit.app.fetch(
    new Request(
      `https://api.pulsarix.test/public/media/report-files/${ticket?.slot}`,
      {
        method: "PUT",
        headers: {
          "content-type": type,
          "content-length": String(shot.length),
          [TICKET_HEADER]: ticket?.ticket as string,
          origin: w.kit.site,
        },
        body: body as unknown as BodyInit,
        duplex: "half",
      } as RequestInit,
    ),
  );
}

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
    const wrong = await putSlot(w, ticket, "image/jpeg", shot);
    expect(wrong.status).toBe(400);
    // The bytes are not a JPEG: the kind refuses them, and that is counted too.
    const liar = await putSlot(
      w,
      ticket,
      "image/png",
      new Uint8Array(shot.length),
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

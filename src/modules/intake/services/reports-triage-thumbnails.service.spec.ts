import { describe, expect, test } from "bun:test";
import { goodReport } from "~/intake";
import {
  type FileOut,
  inbox,
  type ReportOut,
  reportWithFiles,
  setup,
  trackedRead,
  useMediaS3,
} from "~/reports-triage";
import { tenancy } from "../../../config/db";
import { clientHeader } from "../../../http/csrf";
import { TRACKING_HEADER } from "../intake.http";

useMediaS3();

describe("the reporter's own thumbnails", () => {
  async function trackedFiles(w: Awaited<ReturnType<typeof setup>>) {
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
    const [picture, document] = files;
    return { token, files, picture, document };
  }

  test("the status lists the files; the tracking token reads a picture's thumbnail", async () => {
    const w = await setup();
    const { token, files, picture } = await trackedFiles(w);
    expect(files.map((f) => [f.name, f.thumbnailUrl === null])).toEqual([
      ["screen.png", false],
      ["notes.pdf", true],
    ]);
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
  }, 120_000);

  test("a PDF has no thumbnail for the reporter, and no other size or route reads", async () => {
    const w = await setup();
    const { token, picture, document } = await trackedFiles(w);
    const [stored] = await inbox(w).then((r) => r[0]?.files as FileOut[]);

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
  }, 120_000);

  test("the thumbnail is for the UI server only, with the token", async () => {
    const w = await setup();
    const { token, picture } = await trackedFiles(w);

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

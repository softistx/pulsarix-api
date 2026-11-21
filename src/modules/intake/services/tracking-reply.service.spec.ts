import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { ObjectId } from "mongodb";
import { codeOfBody, TICKET_SECRET } from "~/intake";
import { startMediaS3 } from "~/media";
import { DAY, Decline, shot, worldWith } from "~/tracking";
import { clientHeader } from "../../../http/csrf";
import { readTicket, TICKET_HEADER } from "../utils/tickets.utils";

let s3: TestS3;
let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const world = () => worldWith(media);

describe("reply, resolve and reopen", () => {
  test("a reply lands in the thread, with tickets only the UI server may use", async () => {
    const w = await world();
    const { token } = await w.report({
      files: [
        {
          role: "screenshot",
          name: "a.png",
          type: "image/png",
          size: shot.length,
        },
      ],
    });
    const sent = await w.ui("trackingReply", token, {
      input: {
        body: "More detail",
        files: [
          { role: "file", name: "b.png", type: "image/png", size: shot.length },
        ],
      },
    });
    expect(sent.status).toBe(200);
    const reply = sent.body?.data?.["trackingReply"] as unknown as {
      messageId: string;
      files: { slot: string; ticket: string }[];
    };
    const ticket = reply.files[0];
    expect(ticket).toBeDefined();
    if (!ticket) return;
    expect(readTicket(TICKET_SECRET, ticket.ticket)?.tracking).toBe(true);
    const put = (headers: Record<string, string>) =>
      w.kit.kit.app.fetch(
        new Request(
          `https://api.pulsarix.test/public/media/report-files/${ticket.slot}`,
          {
            method: "PUT",
            headers: {
              "content-type": "image/png",
              "content-length": String(shot.length),
              [TICKET_HEADER]: ticket.ticket,
              ...headers,
            },
            body: shot as unknown as BodyInit,
            duplex: "half",
          } as RequestInit,
        ),
      );
    expect((await put({ origin: w.kit.site })).status).toBe(403);
    expect((await put({})).status).toBe(403);
    expect((await put({ [clientHeader]: "pulsarix-ui" })).status).toBe(200);
    const read = await w.status(token);
    const thread = read["thread"] as {
      from: string;
      body: string;
      files: { name: string; thumbnailUrl: string | null }[];
    }[];
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ from: "reporter", body: "More detail" });
    expect(thread[0]?.files[0]?.thumbnailUrl).toMatch(
      /^\/public\/tracking\/files\//,
    );
  });

  test("a declined request refuses reply, resolve and reopen", async () => {
    const w = await world();
    const { token, id } = await w.report();
    await w.kit.asOwner.call(Decline, { id, reason: "Not for us" });
    for (const [op, variables] of [
      ["trackingReply", { input: { body: "please" } }],
      ["trackingResolve", {}],
      ["trackingReopen", {}],
    ] as const) {
      const answer = await w.ui(op, token, variables);
      expect(answer.status).toBe(409);
    }
    expect(await w.status(token)).toMatchObject({
      publicState: "declined",
      canReply: false,
    });
  });

  test("resolve closes it for the reporter, reopen puts it back within 30 days and not after", async () => {
    const w = await world();
    const { token, id } = await w.report();
    await w.accept(id);
    const resolved = await w.ui("trackingResolve", token);
    expect(resolved.body?.data?.["trackingResolve"]).toMatchObject({
      id,
      publicState: "resolved",
    });
    expect(await w.status(token)).toMatchObject({
      publicState: "resolved",
      canReopen: true,
    });
    const reopened = await w.ui("trackingReopen", token);
    expect(reopened.body?.data?.["trackingReopen"]).toMatchObject({
      publicState: "inProgress",
    });
    const old = await w.report();
    await w.accept(old.id);
    await w.ui("trackingResolve", old.token);
    await w.mongo.db.clientReports.update(new ObjectId(old.id), {
      resolvedByReporterAt: new Date(Date.now() - 31 * DAY),
    });
    const late = await w.ui("trackingReopen", old.token);
    expect(late.status).toBe(409);
    expect(codeOfBody(late.body)).toBe("intake.errors.reopen-expired");
  });
});

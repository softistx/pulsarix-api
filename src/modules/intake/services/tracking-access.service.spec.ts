import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { codeOfBody } from "~/intake";
import { startMediaS3 } from "~/media";
import { OPS, shot, worldWith } from "~/tracking";
import { clientHeader } from "../../../http/csrf";
import { TRACKING_HEADER } from "../intake.http";

let s3: TestS3;
let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
beforeAll(async () => {
  ({ s3, media } = await startMediaS3());
}, 300_000);
afterAll(() => s3.stop(), 60_000);

const world = () => worldWith(media);

describe("who may act", () => {
  test("every tracking operation is refused with an Origin or without the client header", async () => {
    const w = await world();
    const { token } = await w.report();
    for (const [id, variables] of OPS) {
      const withOrigin = await w.ui(id, token, variables, {
        origin: w.kit.site,
      });
      expect(withOrigin.status).toBe(403);
      expect(codeOfBody(withOrigin.body)).toBe(
        "intake.errors.origin-not-allowed",
      );
      const bare = await w.ui(id, token, variables, { [clientHeader]: null });
      expect(bare.status).toBe(403);
    }
    // Nothing happened to the report.
    expect((await w.status(token))["emailsOn"]).toBe(true);
  });

  test("a missing, forged or foreign token is the one 404", async () => {
    const w = await world();
    const a = await w.report();
    const missing = await w.ui("trackingResolve", null);
    const forged = await w.ui(
      "trackingResolve",
      `${"0".repeat(24)}.${"A".repeat(43)}`,
    );
    const garbage = await w.ui("trackingResolve", "nope");
    for (const answer of [missing, forged, garbage]) {
      expect(answer.status).toBe(404);
      expect(codeOfBody(answer.body)).toBe("intake.errors.not-found");
    }
    expect((await w.status(a.token))["id"]).toBe(a.id);
  });

  test("the token in the variable still opens the read", async () => {
    const w = await world();
    const { token, id } = await w.report();
    const { response, body } = await w.kit.track(token);
    expect(response.status).toBe(200);
    expect(body?.data?.["clientReportStatus"]).toMatchObject({ id });
  });
});

describe("the read", () => {
  test("gives the thread, impact, type and what the reporter may do", async () => {
    const w = await world();
    const { token, id } = await w.report({ impact: "blocking", type: "bug" });
    expect(await w.status(token)).toMatchObject({
      id,
      impact: "blocking",
      type: "bug",
      thread: [],
      canReply: true,
      canReopen: false,
      resolvedAt: null,
      emailsOn: true,
      publicState: "received",
    });
  });
});

describe("rate limits and foreign ids", () => {
  test("actions share the tracking read limit of the address", async () => {
    const w = await world();
    const { token } = await w.report();
    let last = 200;
    for (let i = 0; i < 31 && last === 200; i += 1) {
      last = (await w.ui("trackingEmails", token, { on: true })).status;
    }
    expect(last).toBe(429);
  });

  test("a thumbnail of another report's file is the same 404 as a missing one", async () => {
    const w = await world();
    const a = await w.report();
    const b = await w.report({
      files: [
        {
          role: "screenshot",
          name: "a.png",
          type: "image/png",
          size: shot.length,
        },
      ],
    });
    const foreign = b.files[0]?.slot ?? "";
    const get = (token: string, file: string) =>
      w.kit.kit.app.fetch(
        new Request(`https://api.pulsarix.test/public/tracking/files/${file}`, {
          headers: { [TRACKING_HEADER]: token, [clientHeader]: "pulsarix-ui" },
        }),
      );
    const [asForeign, asMissing] = await Promise.all([
      get(a.token, foreign),
      get(a.token, "0".repeat(24)),
    ]);
    expect(asForeign.status).toBe(404);
    expect(await asForeign.text()).toBe(await asMissing.text());
  });
});

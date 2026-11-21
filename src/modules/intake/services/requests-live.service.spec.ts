import { describe, expect, test } from "bun:test";
import { AddComment, Decline, Generate, openStream, world } from "~/requests";
import { LIVE_REQUESTS_PATH } from "../intake.http";
import { streamTiming } from "../routes/live.routes";
import { IDENTITY_HEADER } from "./identity.service";

describe("the live stream", () => {
  test("refuses a missing or foreign token and a key it does not know", async () => {
    const w = await world();
    const none = await openStream(w.kit, null, w.kit.key.publicKey);
    expect(none.response.status).toBe(401);
    await none.close();
    const bad = await openStream(w.kit, "garbage", w.kit.key.publicKey);
    expect(bad.response.status).toBe(401);
    await bad.close();
    const unknown = await openStream(w.kit, w.token("ada"), "pk_live_nope");
    expect(unknown.response.status).toBeGreaterThanOrEqual(400);
    await unknown.close();
  });

  test("an origin the key does not allow gets no stream and no CORS header", async () => {
    const w = await world();
    const response = await w.kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test${LIVE_REQUESTS_PATH}?key=${w.kit.key.publicKey}`,
        {
          headers: {
            origin: "https://evil.test",
            [IDENTITY_HEADER]: w.token("ada"),
          },
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("tells the reporter, and only them, when the team replies", async () => {
    const w = await world();
    const a = await w.file("ada");
    await w.file("bob");
    const issueId = await w.accept(a);
    const ada = await w.stream("ada");
    const bob = await w.stream("bob");
    expect(ada.response.status).toBe(200);
    expect(ada.response.headers.get("access-control-allow-origin")).toBe(
      w.kit.site,
    );
    expect(await ada.next("unread")).toEqual({ count: 0 });
    expect(await bob.next("unread")).toEqual({ count: 0 });

    await w.kit.asOwner.call(AddComment, {
      issueId,
      input: { body: "Fixed in the next release", public: true },
    });
    expect(await ada.next("request.updated")).toMatchObject({
      id: a,
      unread: 1,
    });
    expect(await ada.next("unread")).toEqual({ count: 1 });
    expect(
      bob.events.filter((e) => e.event === "request.updated"),
    ).toHaveLength(0);

    await w.data("ada", "markRequestRead", { id: a });
    expect(await ada.next("request.updated")).toMatchObject({
      id: a,
      unread: 0,
    });
    await ada.close();
    await bob.close();
  });

  test("withdrawing or deleting a public reply reaches the stream", async () => {
    const w = await world();
    const a = await w.file("ada");
    const issueId = await w.accept(a);
    const ada = await w.stream("ada");
    await ada.next("unread");
    const add = async (body: string) =>
      (
        await w.kit.asOwner.call<{ addComment: { id: string } }>(AddComment, {
          issueId,
          input: { body, public: true },
        })
      ).addComment.id;
    const first = await add("One");
    await ada.next("request.updated");
    await ada.next("unread");
    await w.kit.asOwner.call(
      `mutation($id: ID!, $input: EditCommentInput!) { editComment(id: $id, input: $input) { id } }`,
      { id: first, input: { public: false } },
    );
    expect(await ada.next("request.updated")).toMatchObject({ id: a });
    await ada.next("unread");
    const second = await add("Two");
    await ada.next("request.updated");
    await ada.next("unread");
    await w.kit.asOwner.call(`mutation($id: ID!) { deleteComment(id: $id) }`, {
      id: second,
    });
    expect(await ada.next("request.updated")).toMatchObject({ id: a });
    await ada.close();
  });

  test("a decision by the team reaches the stream", async () => {
    const w = await world();
    const a = await w.file("ada");
    const ada = await w.stream("ada");
    await ada.next("unread");
    await w.kit.asOwner.call(Decline, { id: a, reason: "No" });
    expect(await ada.next("request.updated")).toMatchObject({
      id: a,
      publicState: "declined",
    });
    await ada.close();
  });

  test("closes when the token expires", async () => {
    const w = await world();
    const ada = await w.stream("ada", 1);
    expect(ada.response.status).toBe(200);
    expect(await ada.untilEnd(5_000)).toBe(true);
    expect(ada.events.some((e) => e.event === "expired")).toBe(true);
    await ada.close();
  });

  test("a revoked key or a rotated identity secret closes an open stream", async () => {
    const before = streamTiming.recheckMs;
    streamTiming.recheckMs = 40;
    try {
      const w = await world();
      const rotated = await w.stream("ada");
      expect(rotated.response.status).toBe(200);
      await rotated.next("unread");
      await w.kit.asOwner.call(Generate, { keyId: w.kit.key.id });
      expect(await rotated.untilEnd(2_000)).toBe(true);
      expect(rotated.events.some((e) => e.event === "expired")).toBe(true);
      await rotated.close();

      const w2 = await world();
      const revoked = await w2.stream("ada");
      expect(revoked.response.status).toBe(200);
      await revoked.next("unread");
      await w2.kit.asOwner.call(
        `mutation($id: ID!) { revokeWidgetKey(id: $id) }`,
        { id: w2.kit.key.id },
      );
      expect(await revoked.untilEnd(2_000)).toBe(true);
      expect(revoked.events.some((e) => e.event === "expired")).toBe(true);
      await revoked.close();
    } finally {
      streamTiming.recheckMs = before;
    }
  });

  test("a recheck that throws keeps the stream open", async () => {
    const before = streamTiming.recheckMs;
    streamTiming.recheckMs = 30;
    const w = await world();
    const real = w.kit.intake.keyOf.bind(w.kit.intake);
    let fail = true;
    let calls = 0;
    w.kit.intake.keyOf = async (publicKey: string) => {
      if (fail) {
        calls += 1;
        throw new Error("database blip");
      }
      return real(publicKey);
    };
    try {
      fail = false;
      const ada = await w.stream("ada");
      expect(ada.response.status).toBe(200);
      await ada.next("unread");
      fail = true;
      await Bun.sleep(200);
      expect(calls).toBeGreaterThan(1);
      expect(ada.ended).toBe(false);
      expect(ada.events.some((e) => e.event === "expired")).toBe(false);
      fail = false;
      await ada.close();
    } finally {
      w.kit.intake.keyOf = real;
      streamTiming.recheckMs = before;
    }
  });

  test("a fourth open stream of one reporter is refused", async () => {
    const w = await world();
    await w.file("ada");
    const open = [];
    for (let i = 0; i < 3; i += 1) {
      const stream = await w.stream("ada");
      expect(stream.response.status).toBe(200);
      open.push(stream);
    }
    const fourth = await w.stream("ada");
    expect(fourth.response.status).toBe(429);
    await fourth.close();
    await open[0]?.close();
    await Bun.sleep(50);
    const again = await w.stream("ada");
    expect(again.response.status).toBe(200);
    await again.close();
    for (const stream of open) await stream.close();
  });
});

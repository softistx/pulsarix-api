import { describe, expect, test } from "bun:test";
import { type IntakeKit, TICKET_SECRET } from "~/intake";
import { errorOf } from "~/media";
import {
  claimsOf,
  held,
  kitWithMedia,
  report,
  send,
  shot,
  slots,
  useMediaS3,
} from "~/uploads";
import { signTicket } from "../utils/tickets.utils";

useMediaS3();

const waitFor = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("the PUT route, hard cases (A12 follow-ups)", () => {
  test("a second PUT while the first holds the slot is a 409, and the first still lands", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    let finish = () => {};
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(shot);
          controller.close();
        };
      },
    });
    const first = send(kit, ticket, slow as never, { length: shot.length });
    await waitFor(
      async () =>
        (await (await slots(kit)).findMany({})).some(
          (file) => file["claimedAt"] instanceof Date,
        ),
      "the first upload to take the slot",
    );
    const second = await send(kit, ticket);
    expect(second.status).toBe(409);
    expect((await errorOf(second)).extensions["code"]).toBe(
      "intake.errors.ticket-used",
    );
    finish();
    const landed = await first;
    expect(landed.status).toBe(200);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "quarantined", claimedAt: null });
  });

  test("a key revoked after the submit refuses the PUT, and nothing is stored", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await kit.asOwner.call(`mutation($id: ID!) { revokeWidgetKey(id: $id) }`, {
      id: kit.key.id,
    });
    const response = await send(kit, ticket);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.unknown-key",
    );
    expect(await held(kit)).toEqual([]);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "pending", claimedAt: null });
  });

  test("a body that is not the declared Content-Length is refused, nothing is stored, and the slot is free again", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const longer = new Uint8Array(shot.length + 64);
    longer.set(shot);
    const shorter = shot.slice(0, shot.length - 10);
    for (const body of [longer, shorter]) {
      const response = await send(kit, ticket, body, { length: shot.length });
      expect(response.status).not.toBe(200);
      expect(await held(kit)).toEqual([]);
      const [file] = await (await slots(kit)).findMany({});
      expect(file).toMatchObject({ state: "pending", claimedAt: null });
    }
    // The right file still goes through.
    expect((await send(kit, ticket)).status).toBe(200);
  });
});

describe("a decoy ticket answers like a real one", () => {
  const decoy = async (kit: IntakeKit) => {
    const { sent, ticket } = await report(kit, shot, {
      website: "http://spam.test",
    });
    expect(sent.response.status).toBe(200);
    return ticket;
  };

  test("a replay is a 409 ticket-used, as a real replay is, and nothing is stored", async () => {
    const kit = await kitWithMedia();
    const ticket = await decoy(kit);
    expect((await send(kit, ticket)).status).toBe(200);
    const again = await send(kit, ticket);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).extensions["code"]).toBe(
      "intake.errors.ticket-used",
    );
    expect(await held(kit)).toEqual([]);
    expect(await (await slots(kit)).findMany({})).toHaveLength(0);
    // Another decoy ticket is not held back by it.
    expect((await send(kit, await decoy(kit))).status).toBe(200);
  });

  test("an expired decoy ticket is a 410, a foreign Origin a 403 with no CORS header", async () => {
    const kit = await kitWithMedia();
    const ticket = await decoy(kit);
    const old = signTicket(TICKET_SECRET, {
      ...claimsOf(ticket),
      expiresAt: Date.now() - 1_000,
    } as never);
    const expired = await send(kit, { ...ticket, ticket: old });
    expect(expired.status).toBe(410);
    expect((await errorOf(expired)).extensions["code"]).toBe(
      "intake.errors.ticket-expired",
    );
    const foreign = await send(kit, ticket, shot, {
      origin: "https://evil.test",
    });
    expect(foreign.status).toBe(403);
    expect((await errorOf(foreign)).extensions["code"]).toBe(
      "intake.errors.origin-not-allowed",
    );
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    // The refusals did not use the ticket up.
    expect((await send(kit, ticket)).status).toBe(200);
  });

  test("a decoy ticket with the wrong type or length is a 400 like a real one", async () => {
    const kit = await kitWithMedia();
    const ticket = await decoy(kit);
    const wrong = await send(kit, ticket, shot, { type: "image/jpeg" });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).extensions["code"]).toBe(
      "intake.errors.upload-mismatch",
    );
  });
});

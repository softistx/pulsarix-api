import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { asPreV2Key, goodReport, type IntakeKit, intakeKit } from "~/intake";
import { errorOf } from "~/media";
import {
  claimsOf,
  held,
  kitWithMedia,
  report,
  send,
  shot,
  slots,
  type Ticket,
  ticketsOf,
  useMediaS3,
} from "~/uploads";
import { QUARANTINE_BYTES } from "../rules/uploads.rules";

useMediaS3();

describe("the PUT route", () => {
  test("the organisation's quarantine is full: 403", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await (await slots(kit)).raw.insertOne({
      _id: new ObjectId(),
      reportId: new ObjectId(),
      role: "file",
      fileName: "big.pdf",
      mime: "application/pdf",
      size: 600 * 1024 * 1024,
      state: "quarantined",
      storageKey: crypto.randomUUID(),
      previewKey: null,
      width: null,
      height: null,
      expiresAt: null,
      claimedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await send(kit, ticket);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.quarantine-full",
    );
  });

  const filler = async (kit: IntakeKit, size: number) =>
    (await slots(kit)).raw.insertOne({
      _id: new ObjectId(),
      reportId: new ObjectId(),
      role: "file",
      fileName: "held.pdf",
      mime: "application/pdf",
      size,
      state: "quarantined",
      storageKey: crypto.randomUUID(),
      previewKey: null,
      width: null,
      height: null,
      expiresAt: null,
      claimedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  test("a file that exactly fits the quarantine is accepted, one byte more is not", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await filler(kit, QUARANTINE_BYTES - shot.length);
    expect((await send(kit, ticket)).status).toBe(200);

    const over = await kitWithMedia();
    const second = await report(over);
    await filler(over, QUARANTINE_BYTES - shot.length + 1);
    const response = await send(over, second.ticket);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.quarantine-full",
    );
  });

  test("a key stored before v2 (no file fields) takes files: submit and PUT", async () => {
    const kit = await kitWithMedia();
    await asPreV2Key(kit);
    const { ticket } = await report(kit);
    expect((await send(kit, ticket)).status).toBe(200);
  });

  test("a toggle turned off after submit refuses the PUT", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    await kit.asOwner.call(
      `mutation($id: ID!, $input: UpdateWidgetKeyInput!) { updateWidgetKey(id: $id, input: $input) { id } }`,
      { id: kit.key.id, input: { attachmentsEnabled: false } },
    );
    const response = await send(kit, ticket);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.attachments-disabled",
    );
    expect(await held(kit)).toEqual([]);
  });

  test("the byte limit of an address is a 429 with a wait", async () => {
    const kit = await kitWithMedia();
    // 36 MiB per ten minutes: each ticket of 4.9 MB costs ~4785 KiB.
    const big = new Uint8Array(4_900_000);
    big.set(shot);
    const files = [1, 2].map((n) => ({
      role: "file",
      name: `n${n}.pdf`,
      type: "application/pdf",
      size: 4_900_000,
    }));
    const tickets: Ticket[] = [];
    for (let i = 0; i < 4; i += 1) {
      const sent = await kit.submit(goodReport({ files }));
      tickets.push(...ticketsOf(sent));
    }
    let refused: Response | undefined;
    for (const ticket of tickets) {
      const response = await send(kit, ticket, big, {
        type: "application/pdf",
      });
      if (response.status === 429) {
        refused = response;
        break;
      }
      await response.arrayBuffer();
    }
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("without a Redis the route is a 503, and without a file store too", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    (kit.intake.deps as { limits: unknown }).limits = undefined;
    const response = await send(kit, ticket);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).extensions["code"]).toBe(
      "intake.errors.unavailable",
    );
    const bare = await intakeKit();
    const { ticket: other } = await report(bare);
    const noStore = await send(bare, other);
    expect(noStore.status).toBe(503);
  });

  test("a bot's ticket is a decoy: it looks accepted and stores nothing", async () => {
    const kit = await kitWithMedia();
    const { sent, ticket } = await report(kit, shot, {
      website: "http://spam.test",
    });
    expect(sent.response.status).toBe(200);
    expect(claimsOf(ticket)["decoy"]).toBe(true);
    const response = await send(kit, ticket);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slot: ticket.slot,
      state: "received",
    });
    expect(await held(kit)).toEqual([]);
    expect(await (await slots(kit)).findMany({})).toHaveLength(0);
  });
});

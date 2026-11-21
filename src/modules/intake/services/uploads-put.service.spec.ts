import { describe, expect, test } from "bun:test";
import { goodReport, TICKET_SECRET } from "~/intake";
import { errorOf, jpegWithGps, onePagePdf } from "~/media";
import {
  claimsOf,
  declared,
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
import { signTicket, TICKET_HEADER } from "../utils/tickets.utils";

useMediaS3();

describe("the PUT route", () => {
  test("a ticket stores the file in quarantine, and a replay is a 409", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const response = await send(kit, ticket);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slot: ticket.slot,
      state: "received",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(kit.site);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "quarantined", width: 64, height: 48 });
    expect((await held(kit)).length).toBeGreaterThan(0);
    const again = await send(kit, ticket);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).extensions["code"]).toBe(
      "intake.errors.ticket-used",
    );
  });

  test("a foreign or missing Origin is a 403 with no CORS header, and nothing is stored", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const before = await held(kit);
    for (const origin of ["https://evil.test", null]) {
      const response = await send(kit, ticket, shot, { origin });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).extensions["code"]).toBe(
        "intake.errors.origin-not-allowed",
      );
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(await held(kit)).toEqual(before);
    // The preflight answers the key's own origin only.
    const preflight = (origin: string) =>
      kit.kit.app.fetch(
        new Request(
          `https://api.pulsarix.test/public/media/report-files/${ticket.slot}`,
          {
            method: "OPTIONS",
            headers: { origin, "access-control-request-method": "PUT" },
          },
        ),
      );
    const ok = await preflight(kit.site);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toContain(
      TICKET_HEADER,
    );
    expect((await preflight("https://evil.test")).status).toBe(403);
  });

  test("a forged, missing, swapped or expired ticket is refused", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const other = (await report(kit)).ticket;
    const code = async (response: Response) =>
      (await errorOf(response)).extensions["code"];
    // Forged: a payload nobody signed, another secret, a flipped signature.
    const claims = claimsOf(ticket) as never;
    const forged = signTicket("f".repeat(40), claims);
    for (const bad of [null, "garbage", forged, `${ticket.ticket}x`]) {
      const response = await send(kit, { ...ticket, ticket: bad as string });
      expect(response.status).toBe(403);
      expect(await code(response)).toBe("intake.errors.ticket-invalid");
    }
    // Swapped: another slot's ticket on this slot's URL.
    const swapped = await send(kit, { ...ticket, ticket: other.ticket });
    expect(swapped.status).toBe(403);
    expect(await code(swapped)).toBe("intake.errors.ticket-invalid");
    // Expired: a genuine signature, a deadline in the past.
    const old = signTicket(TICKET_SECRET, {
      ...(claims as object),
      expiresAt: Date.now() - 1_000,
    } as never);
    const expired = await send(kit, { ...ticket, ticket: old });
    expect(expired.status).toBe(410);
    expect(await code(expired)).toBe("intake.errors.ticket-expired");
    expect(await held(kit)).toEqual([]);
  });

  test("a type or a length other than the ticket's is a 400, a longer one a 413", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    const mismatch = async (response: Response) => {
      expect(response.status).toBe(400);
      expect((await errorOf(response)).extensions["code"]).toBe(
        "intake.errors.upload-mismatch",
      );
    };
    await mismatch(await send(kit, ticket, shot, { type: "image/jpeg" }));
    await mismatch(await send(kit, ticket, shot, { length: shot.length - 1 }));
    await mismatch(await send(kit, ticket, shot, { length: null }));
    const longer = await send(kit, ticket, shot, { length: shot.length + 10 });
    expect(longer.status).toBe(413);
    // The slot is still free for the right file.
    expect((await send(kit, ticket)).status).toBe(200);
  });

  test("a file larger than its limit is a 413 before the body is read", async () => {
    const kit = await kitWithMedia();
    const { ticket } = await report(kit);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await send(kit, ticket, body as never, {
      length: 6 * 1024 * 1024,
    });
    expect(response.status).toBe(413);
    expect(pulled).toBe(0);
    expect(await held(kit)).toEqual([]);
  });

  test("bytes that are not the declared type are a 415 and the slot stays free", async () => {
    const kit = await kitWithMedia();
    const text = new TextEncoder().encode("<html>hello</html>");
    const sent = await kit.submit(
      goodReport({ files: [declared(text, "file", "image/png")] }),
    );
    const [ticket] = ticketsOf(sent);
    const response = await send(kit, ticket as Ticket, text);
    expect(response.status).toBe(415);
    expect(await held(kit)).toEqual([]);
    const [file] = await (await slots(kit)).findMany({});
    expect(file).toMatchObject({ state: "pending", claimedAt: null });
  });

  test("a PDF and a JPEG are stored as what they are", async () => {
    const kit = await kitWithMedia();
    const pdf = onePagePdf();
    const jpeg = await jpegWithGps();
    const sent = await kit.submit(
      goodReport({
        files: [
          {
            role: "file",
            name: "a.pdf",
            type: "application/pdf",
            size: pdf.length,
          },
          {
            role: "screenshot",
            name: "b.jpg",
            type: "image/jpeg",
            size: jpeg.length,
          },
        ],
      }),
    );
    const tickets = ticketsOf(sent);
    expect(
      (await send(kit, tickets[0] as Ticket, pdf, { type: "application/pdf" }))
        .status,
    ).toBe(200);
    expect(
      (await send(kit, tickets[1] as Ticket, jpeg, { type: "image/jpeg" }))
        .status,
    ).toBe(200);
    expect(
      (await (await slots(kit)).findMany({})).every(
        (f) => f["state"] === "quarantined",
      ),
    ).toBe(true);
  });
});

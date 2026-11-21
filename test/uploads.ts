import { afterAll, beforeAll } from "bun:test";
import type { TestS3 } from "@softistx/s3/testing";
import { tenancy } from "../src/config/db";
import { TICKET_HEADER } from "../src/modules/intake/utils/tickets.utils";
import { goodReport, type IntakeKit, intakeKit } from "./intake";
import { bucketKeys, png, startMediaS3 } from "./media";

export let s3: TestS3;
export let media: Awaited<ReturnType<typeof startMediaS3>>["media"];
export function useMediaS3() {
  beforeAll(async () => {
    ({ s3, media } = await startMediaS3());
  }, 300_000);
  afterAll(() => s3.stop(), 60_000);
}

export interface Ticket {
  slot: string;
  role: string;
  ticket: string;
  expiresAt: string;
}
export const shot = png(64, 48);
export const declared = (
  bytes: Uint8Array,
  role = "screenshot",
  type = "image/png",
) => ({
  role,
  name: role === "screenshot" ? "screen.png" : "notes.pdf",
  type,
  size: bytes.length,
});

export const ticketsOf = (sent: {
  body: { data?: Record<string, unknown> | null } | null;
}) => {
  const data = sent.body?.data ?? {};
  return (data["submitClientReport"] as { files: Ticket[] }).files;
};
export const kitWithMedia = () => intakeKit({ media });
// A report with `bytes` declared, its tickets.
export async function report(
  kit: IntakeKit,
  bytes: Uint8Array = shot,
  extra = {},
) {
  const sent = await kit.submit(
    goodReport({ files: [declared(bytes)], ...extra }),
  );
  return { sent, ticket: ticketsOf(sent)[0] as Ticket };
}

export const put = (
  slot: string,
  ticket: string | null,
  bytes: Uint8Array | ReadableStream<Uint8Array>,
  options: {
    origin?: string | null;
    type?: string;
    length?: number | null;
  } & { site: string },
) => {
  const length =
    options.length === undefined
      ? bytes instanceof Uint8Array
        ? bytes.length
        : null
      : options.length;
  return (kit: IntakeKit) =>
    kit.kit.app.fetch(
      new Request(
        `https://api.pulsarix.test/public/media/report-files/${slot}`,
        {
          method: "PUT",
          headers: {
            "content-type": options.type ?? "image/png",
            ...(length !== null && { "content-length": String(length) }),
            ...(ticket && { [TICKET_HEADER]: ticket }),
            ...(options.origin !== null && {
              origin: options.origin ?? options.site,
            }),
          },
          body: bytes as unknown as BodyInit,
          duplex: "half",
        } as RequestInit,
      ),
    );
};
export const send = (
  kit: IntakeKit,
  ticket: Ticket,
  bytes: Uint8Array = shot,
  options: Partial<Parameters<typeof put>[3]> = {},
) =>
  put(ticket.slot, ticket.ticket, bytes, { site: kit.site, ...options })(kit);

export const slots = async (kit: IntakeKit) => {
  const mongo = await tenancy.databaseOf(kit.organisation.id);
  return (
    mongo as never as {
      db: {
        clientReportFiles: {
          findMany: (q: object) => Promise<Record<string, unknown>[]>;
          raw: { insertOne: (doc: object) => Promise<unknown> };
        };
      };
    }
  ).db.clientReportFiles;
};
export const held = (kit: IntakeKit) =>
  bucketKeys(s3, `organisations/${kit.organisation.id}/`);
export const claimsOf = (ticket: Ticket) =>
  JSON.parse(
    Buffer.from(ticket.ticket.split(".")[0] as string, "base64url").toString(),
  ) as Record<string, unknown>;

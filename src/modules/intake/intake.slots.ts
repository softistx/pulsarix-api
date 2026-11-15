import type { ObjectId } from "mongodb";
import type { CheckedFile } from "./intake.files.input";
import { newSlot } from "./intake.files.input";
import { PENDING_SLOT_MINUTES } from "./intake.files.retention";
import type { WidgetKeyDocument } from "./intake.model";
import type { IntakeMongo } from "./intake.submit";
import { signTicket } from "./intake.tickets";

// The upload tickets a report hands out (plan §17, A12): one per declared
// file, signed (intake.tickets.ts), and, for a real report, one pending slot
// per file in the organisation's database.

// One ticket per declared file, in the order declared: the widget PUTs the
// file to `/public/media/report-files/<slot>` with the ticket in
// `x-pulsarix-ticket` (intake.uploads.routes.ts).
export interface FileTicket {
  slot: string;
  role: CheckedFile["role"];
  ticket: string;
  expiresAt: Date;
}

// When a ticket (and its pending slot) stops being good.
export const ticketExpiry = (now: Date) =>
  new Date(now.getTime() + PENDING_SLOT_MINUTES * 60_000);

export function ticketFor(
  secret: string,
  key: Pick<WidgetKeyDocument, "organisationId" | "_id">,
  reportId: string,
  slot: string,
  file: CheckedFile,
  decoy: boolean,
  expiresAt: Date,
): FileTicket {
  return {
    slot,
    role: file.role,
    expiresAt,
    ticket: signTicket(secret, {
      organisationId: key.organisationId.toHexString(),
      keyId: key._id.toHexString(),
      reportId,
      slot,
      type: file.type,
      size: file.size,
      expiresAt: expiresAt.getTime(),
      decoy,
    }),
  };
}

// A bot's tickets: signed like the others, naming slots nobody made; their
// PUT stores nothing (intake.uploads.ts).
export function decoyTickets(
  secret: string,
  key: WidgetKeyDocument,
  reportId: string,
  files: CheckedFile[],
  expiresAt: Date,
): FileTicket[] {
  return files.map((file) =>
    ticketFor(secret, key, reportId, newSlot(), file, true, expiresAt),
  );
}

// The pending slots of a created report, one per file, and their tickets.
export async function reserveSlots(
  secret: string,
  mongo: IntakeMongo,
  key: WidgetKeyDocument,
  report: { _id: ObjectId; id: string },
  files: CheckedFile[],
  expiresAt: Date,
): Promise<FileTicket[]> {
  const tickets: FileTicket[] = [];
  for (const file of files) {
    const slot = await mongo.db.clientReportFiles.create({
      reportId: report._id,
      role: file.role,
      fileName: file.name,
      mime: file.type,
      size: file.size,
      storageKey: null,
      previewKey: null,
      width: null,
      height: null,
      state: "pending",
      expiresAt,
      claimedAt: null,
    });
    tickets.push(
      ticketFor(secret, key, report.id, slot.id, file, false, expiresAt),
    );
  }
  return tickets;
}

import type { ObjectId } from "mongodb";
import type { CheckedFile } from "../rules/files-input.rules";
import { newSlot } from "../rules/files-input.rules";
import { PENDING_SLOT_MINUTES } from "./files-retention.service";
import type { IntakeMongo } from "./submit.service";
import { signTicket } from "../utils/tickets.utils";
import type { ReportFileRole, WidgetKeyDocument } from "../models";

// The upload tickets a report hands out (plan §17, A12): one per declared
// file, signed (intake.tickets.ts), and, for a real report, one pending slot
// per file in the organisation's database.

// One ticket per declared file, in the order declared: the widget PUTs the
// file to `/public/media/report-files/<slot>` with the ticket in
// `x-pulsarix-ticket` (routes/uploads.routes.ts).
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
  tracking = false,
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
      ...(tracking && { tracking }),
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

// The pending slots of a report, one per file, and their tickets. A reply's
// files (A16) are stored with the role `reply` and the message they belong to;
// the ticket still carries the declared role.
export async function reserveSlots(
  secret: string,
  mongo: IntakeMongo,
  key: WidgetKeyDocument,
  report: { _id: ObjectId; id: string },
  files: CheckedFile[],
  expiresAt: Date,
  reply?: { messageId: ObjectId; tracking?: boolean },
): Promise<FileTicket[]> {
  const tickets: FileTicket[] = [];
  for (const file of files) {
    const slot = await mongo.db.clientReportFiles.create({
      reportId: report._id,
      role: (reply ? "reply" : file.role) satisfies ReportFileRole,
      messageId: reply?.messageId ?? null,
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
      ticketFor(
        secret,
        key,
        report.id,
        slot.id,
        file,
        false,
        expiresAt,
        reply?.tracking === true,
      ),
    );
  }
  return tickets;
}

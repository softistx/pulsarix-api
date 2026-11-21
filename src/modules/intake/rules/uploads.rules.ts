import { fileTooLarge, uploadMismatch } from "../intake.errors";
import { maxFileBytes } from "../intake.files.kinds";
import type { TicketClaims } from "../utils/tickets.utils";

// How much an organisation's quarantine holds, pending slots included: the
// bytes strangers can leave in one organisation's bucket before the team looks.
export const QUARANTINE_BYTES = 512 * 1024 * 1024;

// The content type without its parameters, in lower case.
export const essenceOf = (type: string | null) =>
  (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

// The announced type and length are the ticket's, exactly.
export function checkAnnounced(
  claims: TicketClaims,
  upload: { contentType: string | null; length: string | null },
) {
  if (essenceOf(upload.contentType) !== claims.type) throw uploadMismatch();
  const declared = /^\d{1,10}$/.test(upload.length ?? "")
    ? Number(upload.length)
    : null;
  if (declared === null) throw uploadMismatch();
  if (declared > claims.size) throw fileTooLarge(maxFileBytes);
  if (declared !== claims.size) throw uploadMismatch();
}

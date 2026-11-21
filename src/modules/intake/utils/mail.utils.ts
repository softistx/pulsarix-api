import { createHmac } from "node:crypto";
import type { ObjectId } from "mongodb";
import type { ClientReportDocument } from "../models";

export type Mailable = Pick<
  ClientReportDocument,
  "id" | "email" | "emailsOff" | "erasedAt"
>;

const REPLY_CLIP = 1_000;

// A report with no e-mail, whose reporter turned the e-mails off or whose data
// was erased gets none.
export const wantsMail = (report: Mailable) =>
  !!report.email && report.emailsOff !== true && !report.erasedAt;

export const clip = (text: string) =>
  text.length > REPLY_CLIP ? `${text.slice(0, REPLY_CLIP)}…` : text;

// The secret the unsubscribe links are signed with, derived from the upload
// tickets' key so that no new setting is needed.
export const unsubscribeSecret = (ticketSecret: string) =>
  createHmac("sha256", ticketSecret)
    .update("pulsarix reporter mail unsubscribe")
    .digest("hex");

// The page the reporter filed from, as a link in the e-mail: only when its
// origin is one of the key's allowed origins. The page URL is client-supplied,
// so any other would let a reporter put their own link in a branded mail.
export async function hostPageLink(
  report: Pick<ClientReportDocument, "pageUrl" | "widgetKeyId">,
  allowedOrigins: (widgetKeyId: ObjectId) => Promise<readonly string[]>,
): Promise<string | null> {
  if (!report.pageUrl) return null;
  let origin: string;
  try {
    origin = new URL(report.pageUrl).origin;
  } catch {
    return null;
  }
  const allowed = await allowedOrigins(report.widgetKeyId);
  return allowed.includes(origin) ? report.pageUrl : null;
}

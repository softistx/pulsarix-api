import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// An upload ticket (plan §17, A12): what `submitClientReport` hands the widget
// for each file, and the widget gives back, in `x-pulsarix-ticket`, on the PUT
// of that file. It is signed (HMAC-SHA256), so the PUT route needs no state to
// know it is genuine: it names the organisation, the widget key, the report,
// the slot (the file's id), the exact type and size the slot was made for, and
// the deadline. `decoy` marks a ticket handed to a bot: it verifies like any
// other, and its PUT stores nothing.
export const TICKET_MINUTES = 15;
export const TICKET_HEADER = "x-pulsarix-ticket";

const claims = z.object({
  organisationId: z.string().regex(/^[0-9a-f]{24}$/),
  keyId: z.string().regex(/^[0-9a-f]{24}$/),
  reportId: z.string().regex(/^[0-9a-f]{24}$/),
  slot: z.string().regex(/^[0-9a-f]{24}$/),
  type: z.string().min(1).max(100),
  size: z.number().int().min(1),
  expiresAt: z.number().int(),
  decoy: z.boolean(),
  // A ticket of the tracking page: its PUT comes from the UI server (no
  // `Origin`, the client header), never from a browser.
  tracking: z.boolean().optional(),
});
export type TicketClaims = z.infer<typeof claims>;

const mac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

// `<payload>.<signature>`, both base64url.
export function signTicket(secret: string, given: TicketClaims): string {
  const payload = Buffer.from(JSON.stringify(given)).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

// The claims of a ticket whose signature holds, or null for anything else
// (damaged, forged, signed with another secret). Expiry is the caller's.
export function readTicket(secret: string, token: string): TicketClaims | null {
  if (token.length > 1_000) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const parsed = claims.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

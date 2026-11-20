import { createHmac, timingSafeEqual } from "node:crypto";
import { alxia } from "@alxia/core";
import { ObjectId } from "mongodb";
import type { AppTenancy } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { localeOfRequest } from "../../i18n/locale";
import { escapeHtml } from "../../mail/escape";
import { secure } from "./intake.http";
import type { IntakeMongo } from "./intake.submit";

// The one-click unsubscribe of the reporter's e-mails (plan §19, A19). The
// link in each e-mail is `<UI origin>/public/unsubscribe/<org>.<report>.<mac>`:
// the MAC is an HMAC of the organisation and report ids under the server's
// ticket secret, so only an e-mail this server sent opens it, and nothing is
// stored. It sets the same `emailsOff` flag as the widget's and the tracking
// page's toggle (`setRequestEmails`, `trackingEmails`).

export const UNSUBSCRIBE_PATH = "/public/unsubscribe";

const mac = (secret: string, organisationId: string, reportId: string) =>
  createHmac("sha256", secret)
    .update(`pulsarix reporter unsubscribe\n${organisationId}.${reportId}`)
    .digest("base64url");

export const unsubscribeToken = (
  secret: string,
  organisationId: string,
  reportId: string,
) => `${organisationId}.${reportId}.${mac(secret, organisationId, reportId)}`;

const ID = /^[0-9a-f]{24}$/;

// The organisation and report a token names, or null when it is no token this
// server signed (compared in constant time).
export function parseUnsubscribeToken(
  secret: string,
  token: string,
): { organisationId: string; reportId: string } | null {
  const [organisationId, reportId, given, ...rest] = token.split(".");
  if (rest.length > 0 || !organisationId || !reportId || !given) return null;
  if (!ID.test(organisationId) || !ID.test(reportId)) return null;
  const expected = Buffer.from(mac(secret, organisationId, reportId));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual)
    ? { organisationId, reportId }
    : null;
}

// Turns the e-mails off: for every request of the reporter under the same key
// when the report is an identified one (as `setRequestEmails` does), for the
// report alone otherwise (as `trackingEmails`). Safe to repeat.
export async function unsubscribeReport(
  mongo: IntakeMongo,
  reportId: string,
): Promise<boolean> {
  const as = mongo.as(SYSTEM_ACTOR);
  const report = await as.db.clientReports.findById(new ObjectId(reportId));
  if (!report) return false;
  if (report.reporterKey && !report.erasedAt) {
    await as.db.clientReports.updateMany(
      {
        widgetKeyId: report.widgetKeyId,
        reporterKey: report.reporterKey,
        erasedAt: null,
      },
      { emailsOff: true },
    );
  } else {
    await as.db.clientReports.update(report._id, { emailsOff: true });
  }
  return true;
}

const page = (locale: "en" | "fr", done: boolean, action: string) => {
  const t =
    locale === "fr"
      ? {
          title: "E-mails de suivi",
          ask: "Ne plus recevoir les e-mails de suivi de votre signalement ?",
          button: "Me désabonner",
          done: "C'est fait : vous ne recevrez plus ces e-mails.",
        }
      : {
          title: "Request e-mails",
          ask: "Stop the e-mails about your report?",
          button: "Unsubscribe",
          done: "Done: you will not get these e-mails any more.",
        };
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="robots" content="noindex"><title>${t.title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">${
    done
      ? `<p>${escapeHtml(t.done)}</p>`
      : `<p>${escapeHtml(t.ask)}</p><form method="post" action="${escapeHtml(action)}"><button type="submit">${escapeHtml(t.button)}</button></form>`
  }</body></html>`;
};

const html = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { ...secure, "content-type": "text/html; charset=utf-8" },
  });

// GET /public/unsubscribe/<token>: a page with one button (a mail scanner that
// fetches the link unsubscribes nobody). POST: unsubscribes; this is the
// `List-Unsubscribe-Post` target a mail client calls with
// `List-Unsubscribe=One-Click`, and the page's button. An unknown or forged
// token is a 404 and touches nothing.
export function unsubscribeRoutes(
  tenancy: Pick<AppTenancy, "databaseOf">,
  secret: () => string,
  log = console.warn,
) {
  return alxia().all(
    `${UNSUBSCRIBE_PATH}/:token`,
    async ({ request, params }) => {
      const token = params["token"] ?? "";
      const named = parseUnsubscribeToken(secret(), token);
      const locale = localeOfRequest();
      if (request.method !== "GET" && request.method !== "POST") {
        return new Response(null, {
          status: 405,
          headers: { ...secure, allow: "GET, POST" },
        });
      }
      if (!named) return html(404, "");
      if (request.method === "GET") {
        return html(
          200,
          page(
            locale,
            false,
            `${UNSUBSCRIBE_PATH}/${encodeURIComponent(token)}`,
          ),
        );
      }
      try {
        const mongo = await tenancy.databaseOf(named.organisationId);
        await unsubscribeReport(mongo, named.reportId);
      } catch (error) {
        log("reporter unsubscribe failed", error);
        return html(500, "");
      }
      return html(200, page(locale, true, ""));
    },
  );
}

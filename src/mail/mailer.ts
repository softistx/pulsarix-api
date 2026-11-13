import type { Mailer } from "@softistx/mail";
import { createSmtpMailer } from "@softistx/mail-smtp";
import nodemailer from "nodemailer";
import { createConsoleMailer } from "./console-mailer";

// The mailer the server sends with: SMTP through MAIL_URL (smtp:// or
// smtps://, credentials in the URL), which production requires
// (src/config/env.ts); without it, outside production, the console mailer,
// which prints each mail. In development docker-compose.yml's Mailpit takes
// SMTP on port 1026.
export function serverMailer(mailUrl: string | undefined): Mailer {
  if (!mailUrl) return createConsoleMailer();
  return createSmtpMailer({ transporter: nodemailer.createTransport(mailUrl) });
}

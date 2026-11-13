import type { Mailer } from "@softistx/mail";
import { serverMailer } from "../mail/mailer";
import { env } from "./env";

// The mailer the API sends with: SMTP through MAIL_URL, or the console without
// it (src/mail/mailer.ts). A mail queue over Redis joins with the slice that
// adds Redis.
export const mailer: Mailer = serverMailer(env.MAIL_URL);

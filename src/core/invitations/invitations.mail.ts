import type { Rendered } from "@softistx/mail";
import type { Locale } from "../../i18n/locale";
import { escapeHtml } from "../../mail/escape";
import type { Role } from "../access";

export interface InvitationMail {
  locale: Locale;
  // Whom it greets, and the organisation that invites them.
  name: string;
  organisation: string;
  role: Role;
  // The page of pulsarix-ui that accepts it, with the token.
  link: string;
  // When the link stops working.
  expiresAt: Date;
}

const copy = {
  en: {
    roles: {
      owner: "an owner",
      admin: "an administrator",
      member: "a member",
      viewer: "a viewer",
    },
    subject: (organisation: string) =>
      `Invitation to join ${organisation} on pulsarix`,
    hello: (name: string) => `Hello ${name},`,
    body: (organisation: string, role: string) =>
      `${organisation} invites you to join pulsarix as ${role}.`,
    action: "Accept the invitation",
    expires: (date: string) => `This link expires on ${date}.`,
    ignore:
      "If you did not expect this invitation, ignore this message: no account is made without you.",
  },
  fr: {
    roles: {
      owner: "propriétaire",
      admin: "administrateur ou administratrice",
      member: "membre",
      viewer: "lecteur ou lectrice",
    },
    subject: (organisation: string) =>
      `Invitation à rejoindre ${organisation} sur pulsarix`,
    hello: (name: string) => `Bonjour ${name},`,
    body: (organisation: string, role: string) =>
      `${organisation} vous invite à rejoindre pulsarix en tant que ${role}.`,
    action: "Accepter l'invitation",
    expires: (date: string) => `Ce lien expire le ${date}.`,
    ignore:
      "Si vous n'attendiez pas cette invitation, ignorez ce message : aucun compte n'est créé sans vous.",
  },
} as const;

// The invitation mail, in English or French: our own, since janus-mail has no
// invitation. Its link carries the token, and nothing else does.
export function invitationMail(mail: InvitationMail): Rendered {
  const t = copy[mail.locale];
  const date = new Intl.DateTimeFormat(mail.locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(mail.expiresAt);
  const lines = [
    t.hello(mail.name),
    t.body(mail.organisation, t.roles[mail.role]),
    t.expires(date),
    t.ignore,
  ];
  const [hello, body, expires, ignore] = lines.map(escapeHtml);
  return {
    subject: t.subject(mail.organisation),
    text: [
      lines[0],
      lines[1],
      `${t.action}: ${mail.link}`,
      lines[2],
      lines[3],
    ].join("\n\n"),
    html: [
      `<p>${hello}</p>`,
      `<p>${body}</p>`,
      `<p><a href="${escapeHtml(mail.link)}">${escapeHtml(t.action)}</a></p>`,
      `<p>${expires}</p>`,
      `<p>${ignore}</p>`,
    ].join("\n"),
  };
}

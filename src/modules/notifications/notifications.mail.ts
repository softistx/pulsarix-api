import type { Rendered } from "@softistx/mail";
import type { Locale } from "../../i18n/locale";
import { escapeHtml } from "../../mail/escape";
import type { NotificationKind } from "./notifications.model";

export interface DigestItem {
  kind: NotificationKind;
  // Who did it; null when their account is gone.
  actor: string | null;
  issueKey: string;
  issueTitle: string;
}

export interface DigestMail {
  locale: Locale;
  name: string;
  organisation: string;
  // The inbox page of pulsarix-ui.
  link: string;
  items: DigestItem[];
  // Notifications beyond `items`, counted only.
  more: number;
}

const copy = {
  en: {
    subject: (count: number, organisation: string) =>
      `${count} unread ${count === 1 ? "notification" : "notifications"} on ${organisation}`,
    hello: (name: string) => `Hello ${name},`,
    intro: (organisation: string) =>
      `Here is what you have not read yet on ${organisation}:`,
    someone: "Someone",
    line: (kind: NotificationKind, actor: string, key: string, title: string) =>
      ({
        mention: `${actor} mentioned you on ${key}: ${title}`,
        assigned: `${actor} assigned ${key} to you: ${title}`,
        watchedChange: `${actor} changed ${key}, which you watch: ${title}`,
      })[kind],
    more: (count: number) => `And ${count} more.`,
    action: "Open your notifications",
  },
  fr: {
    subject: (count: number, organisation: string) =>
      `${count} ${count === 1 ? "notification non lue" : "notifications non lues"} sur ${organisation}`,
    hello: (name: string) => `Bonjour ${name},`,
    intro: (organisation: string) =>
      `Voici ce que vous n'avez pas encore lu sur ${organisation} :`,
    someone: "Quelqu'un",
    line: (kind: NotificationKind, actor: string, key: string, title: string) =>
      ({
        mention: `${actor} vous a mentionné sur ${key} : ${title}`,
        assigned: `${actor} vous a assigné ${key} : ${title}`,
        watchedChange: `${actor} a modifié ${key}, que vous suivez : ${title}`,
      })[kind],
    more: (count: number) => `Et ${count} de plus.`,
    action: "Ouvrir vos notifications",
  },
} as const;

// The digest of a member's unread notifications, in English or French: our
// own, since janus-mail has none. It names issues, never their content.
export function digestMail(mail: DigestMail): Rendered {
  const t = copy[mail.locale];
  const lines = mail.items.map((item) =>
    t.line(item.kind, item.actor ?? t.someone, item.issueKey, item.issueTitle),
  );
  const count = mail.items.length + mail.more;
  const more = mail.more > 0 ? t.more(mail.more) : null;
  return {
    subject: t.subject(count, mail.organisation),
    text: [
      t.hello(mail.name),
      t.intro(mail.organisation),
      lines.map((line) => `- ${line}`).join("\n"),
      ...(more ? [more] : []),
      `${t.action}: ${mail.link}`,
    ].join("\n\n"),
    html: [
      `<p>${escapeHtml(t.hello(mail.name))}</p>`,
      `<p>${escapeHtml(t.intro(mail.organisation))}</p>`,
      `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`,
      ...(more ? [`<p>${escapeHtml(more)}</p>`] : []),
      `<p><a href="${escapeHtml(mail.link)}">${escapeHtml(t.action)}</a></p>`,
    ].join("\n"),
  };
}

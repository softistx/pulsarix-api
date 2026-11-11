import type { Rendered } from "@softistx/mail";
import type { Locale } from "../../i18n/locale";
import { escapeHtml } from "../../mail/escape";

export interface TrackingMail {
  locale: Locale;
  // The project the report was sent to: set by the team, never by the sender.
  projectName: string;
  // The tracking page, its token in the path.
  link: string;
}

const copy = {
  en: {
    subject: (project: string) => `We received your report on ${project}`,
    body: (project: string) =>
      `Thank you: your report on ${project} reached the team.`,
    follow: "Follow what happens to it here (keep this link private):",
    ignore: "If you did not send a report, ignore this e-mail.",
  },
  fr: {
    subject: (project: string) =>
      `Nous avons reçu votre signalement sur ${project}`,
    body: (project: string) =>
      `Merci : votre signalement sur ${project} est arrivé à l'équipe.`,
    follow: "Suivez son avancement ici (gardez ce lien privé) :",
    ignore: "Si vous n'avez envoyé aucun signalement, ignorez cet e-mail.",
  },
} as const;

// The e-mail that carries the tracking link to the reporter. It repeats nothing
// the sender typed (the address may not be theirs): only the project's name.
export function trackingMail(mail: TrackingMail): Rendered {
  const t = copy[mail.locale];
  return {
    subject: t.subject(mail.projectName),
    text: [t.body(mail.projectName), `${t.follow} ${mail.link}`, t.ignore].join(
      "\n\n",
    ),
    html: [
      `<p>${escapeHtml(t.body(mail.projectName))}</p>`,
      `<p>${escapeHtml(t.follow)} <a href="${escapeHtml(mail.link)}">${escapeHtml(mail.link)}</a></p>`,
      `<p>${escapeHtml(t.ignore)}</p>`,
    ].join("\n"),
  };
}

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

export interface ReporterMail {
  locale: Locale;
  projectName: string;
  // The team's public replies since the last e-mail, oldest first. Empty for
  // a tracking report: the e-mail says there are replies and links to the page.
  replies: string[];
  // How many replies there are (the list above may be left empty).
  replyCount: number;
  // The public state the request is in, when it changed since the last e-mail.
  state: "received" | "inProgress" | "resolved" | "declined" | null;
  declineReason: string | null;
  // The tracking page or the host page; null when there is none to link.
  link: string | null;
  unsubscribe: string;
}

const states = {
  en: {
    received: "Received",
    inProgress: "In progress",
    resolved: "Resolved",
    declined: "Declined",
  },
  fr: {
    received: "Reçu",
    inProgress: "En cours",
    resolved: "Résolu",
    declined: "Refusé",
  },
} as const;

const reporterCopy = {
  en: {
    subject: (project: string) => `News on your report on ${project}`,
    intro: (project: string) =>
      `The team of ${project} has news on your report.`,
    replies: (n: number) =>
      n === 1 ? "The team replied:" : `The team replied (${n} replies):`,
    repliesLinked: (n: number) =>
      n === 1
        ? "The team replied to your report."
        : `The team replied ${n} times.`,
    state: (label: string) => `Its state is now: ${label}.`,
    reason: (reason: string) => `Reason: ${reason}`,
    open: "Read it and answer here:",
    unsubscribe: "Stop these e-mails:",
  },
  fr: {
    subject: (project: string) =>
      `Du nouveau sur votre signalement sur ${project}`,
    intro: (project: string) =>
      `L'équipe de ${project} a du nouveau sur votre signalement.`,
    replies: (n: number) =>
      n === 1 ? "L'équipe a répondu :" : `L'équipe a répondu (${n} réponses) :`,
    repliesLinked: (n: number) =>
      n === 1
        ? "L'équipe a répondu à votre signalement."
        : `L'équipe a répondu ${n} fois.`,
    state: (label: string) => `Son état est maintenant : ${label}.`,
    reason: (reason: string) => `Motif : ${reason}`,
    open: "Lisez-le et répondez ici :",
    unsubscribe: "Ne plus recevoir ces e-mails :",
  },
} as const;

// The one e-mail of a batch (A19): the replies and the state change since the
// last one. It never repeats the report's own title or text (the address may
// not be the sender's); the team's replies are shown only to an identified
// reporter, whose address the host vouched for.
export function reporterMail(mail: ReporterMail): Rendered {
  const t = reporterCopy[mail.locale];
  const lines: string[] = [t.intro(mail.projectName)];
  if (mail.replyCount > 0) {
    if (mail.replies.length > 0) {
      lines.push(
        t.replies(mail.replyCount),
        ...mail.replies.map((r) => `> ${r}`),
      );
    } else {
      lines.push(t.repliesLinked(mail.replyCount));
    }
  }
  if (mail.state) {
    lines.push(t.state(states[mail.locale][mail.state]));
    if (mail.declineReason) lines.push(t.reason(mail.declineReason));
  }
  const tail = [
    ...(mail.link ? [`${t.open} ${mail.link}`] : []),
    `${t.unsubscribe} ${mail.unsubscribe}`,
  ];
  const html = [
    ...lines.map((line) =>
      line.startsWith("> ")
        ? `<blockquote>${escapeHtml(line.slice(2))}</blockquote>`
        : `<p>${escapeHtml(line)}</p>`,
    ),
    ...(mail.link
      ? [
          `<p>${escapeHtml(t.open)} <a href="${escapeHtml(mail.link)}">${escapeHtml(mail.link)}</a></p>`,
        ]
      : []),
    `<p>${escapeHtml(t.unsubscribe)} <a href="${escapeHtml(mail.unsubscribe)}">${escapeHtml(mail.unsubscribe)}</a></p>`,
  ].join("\n");
  return {
    subject: t.subject(mail.projectName),
    text: [...lines, ...tail].join("\n\n"),
    html,
  };
}

import type { Locale } from "./locale";

// The text of the intake module's error codes (public widget endpoints and the
// report files), in each language; merged into `texts` by `texts.ts`.
export const intakeTexts: Record<Locale, Record<string, string>> = {
  en: {
    "intake.errors.unknown-key": "This widget key does not exist.",
    "intake.errors.origin-not-allowed":
      "This site is not allowed to use this widget key.",
    "intake.errors.key-disabled": "This widget is switched off.",
    "intake.errors.too-many-requests":
      "Too many requests. Try again in {minutes, plural, one {# minute} other {# minutes}}.",
    "intake.errors.unavailable":
      "Reports cannot be taken right now. Try again shortly.",
    "intake.errors.persisted-only":
      "Send a known operation by its id, with its variables.",
    "intake.errors.unsupported-media": "Send the request as application/json.",
    "intake.errors.too-fast":
      "That was quick. Check your report and send it again.",
    "intake.errors.key-not-found": "This widget key does not exist.",
    "intake.errors.not-found": "This report does not exist.",
    "intake.errors.report-decided": "This report has been decided already.",
    "intake.errors.invalid-origin":
      '"{origin}" is not an origin: use https://host[:port], with no path.',
    "intake.errors.file-unsupported-type":
      "Only PNG, JPEG and WebP pictures and PDF files can be attached.",
    "intake.errors.file-undecodable":
      "This file is empty, damaged or too small to be read.",
    "intake.errors.file-too-large": "This file is too large: at most {max} MB.",
    "intake.errors.file-too-many-pixels":
      "This picture is too large: at most {max} megapixels.",
    "intake.errors.attachments-disabled":
      "This widget does not take screenshots or files.",
    "intake.errors.too-many-files":
      "No more than {max} files can be attached to a report.",
    "intake.errors.files-too-large":
      "These files are too large together: at most {max} MB.",
    "intake.errors.ticket-invalid": "This upload is not allowed.",
    "intake.errors.ticket-expired":
      "This upload took too long. Send the report again.",
    "intake.errors.ticket-used": "This file was already sent.",
    "intake.errors.upload-mismatch":
      "This is not the file that was announced with the report.",
    "intake.errors.quarantine-full":
      "Files cannot be taken right now. Send the report without them.",
    "intake.errors.file-not-found": "This file does not exist.",
    "intake.errors.identity-invalid":
      "Your identity could not be confirmed. Sign in again and retry.",
    "intake.errors.request-declined":
      "This request was declined: it can no longer be answered.",
    "intake.errors.reopen-expired":
      "This request was resolved too long ago to be reopened. Send a new request.",
  },
  fr: {
    "intake.errors.unknown-key": "Cette clé de widget n'existe pas.",
    "intake.errors.origin-not-allowed":
      "Ce site n'est pas autorisé à utiliser cette clé de widget.",
    "intake.errors.key-disabled": "Ce widget est désactivé.",
    "intake.errors.too-many-requests":
      "Trop de requêtes. Réessayez dans {minutes, plural, one {# minute} other {# minutes}}.",
    "intake.errors.unavailable":
      "Les signalements ne peuvent pas être pris pour le moment. Réessayez bientôt.",
    "intake.errors.persisted-only":
      "Envoyez une opération connue par son id, avec ses variables.",
    "intake.errors.unsupported-media":
      "Envoyez la requête en application/json.",
    "intake.errors.too-fast":
      "C'était rapide. Relisez votre signalement et envoyez-le de nouveau.",
    "intake.errors.key-not-found": "Cette clé de widget n'existe pas.",
    "intake.errors.not-found": "Ce signalement n'existe pas.",
    "intake.errors.report-decided": "Ce signalement a déjà été traité.",
    "intake.errors.invalid-origin":
      "« {origin} » n'est pas une origine : utilisez https://hôte[:port], sans chemin.",
    "intake.errors.file-unsupported-type":
      "Seules les images PNG, JPEG et WebP et les fichiers PDF peuvent être joints.",
    "intake.errors.file-undecodable":
      "Ce fichier est vide, abîmé ou trop petit pour être lu.",
    "intake.errors.file-too-large":
      "Ce fichier est trop volumineux : {max} Mo au plus.",
    "intake.errors.file-too-many-pixels":
      "Cette image est trop grande : {max} mégapixels au plus.",
    "intake.errors.attachments-disabled":
      "Ce widget n'accepte ni capture d'écran ni fichier.",
    "intake.errors.too-many-files":
      "On ne peut pas joindre plus de {max} fichiers à un signalement.",
    "intake.errors.files-too-large":
      "Ces fichiers sont trop volumineux ensemble : {max} Mo au plus.",
    "intake.errors.ticket-invalid": "Cet envoi n'est pas autorisé.",
    "intake.errors.ticket-expired":
      "Cet envoi a pris trop de temps. Envoyez de nouveau le signalement.",
    "intake.errors.ticket-used": "Ce fichier a déjà été envoyé.",
    "intake.errors.upload-mismatch":
      "Ce n'est pas le fichier annoncé avec le signalement.",
    "intake.errors.quarantine-full":
      "Les fichiers ne peuvent pas être pris pour le moment. Envoyez le signalement sans eux.",
    "intake.errors.file-not-found": "Ce fichier n'existe pas.",
    "intake.errors.identity-invalid":
      "Votre identité n'a pas pu être confirmée. Reconnectez-vous et réessayez.",
    "intake.errors.request-declined":
      "Cette demande a été refusée : on ne peut plus y répondre.",
    "intake.errors.reopen-expired":
      "Cette demande a été résolue il y a trop longtemps pour être rouverte. Envoyez une nouvelle demande.",
  },
};

import type { Locale } from "./locale";

// The text of every error code in each language (ICU messages, interpolating
// the `params` of the refusal). English is the default, French is offered
// (plan Q14). `src/i18n/texts.spec.ts` fails when a declared code lacks one.
export const texts: Record<Locale, Record<string, string>> = {
  en: {
    "auth.errors.client-header-required":
      "The {header} header is required on every request.",
    "auth.errors.unauthenticated": "Sign in to continue.",
    "auth.errors.forbidden": "You are not allowed to do this.",
    "auth.errors.unavailable":
      "The service is temporarily unavailable. Try again shortly.",
    "auth.errors.invalid-credentials": "The e-mail or the password is wrong.",
    "auth.errors.invalid-token": "This link or code is invalid or has expired.",
    "auth.errors.too-many-attempts":
      "Too many attempts. Try again in {minutes, plural, one {# minute} other {# minutes}}.",
    "auth.errors.exhausted":
      "The request kept colliding with others. Try again.",
    "auth.errors.step-up-required":
      "Confirm it is you to continue: ask for a confirmation code.",
    "auth.errors.invalid-code":
      "The code is wrong, or it has expired or been used already.",
    "auth.errors.second-factor-active":
      "A second factor is already active. Disable it first.",
    "auth.errors.second-factor-not-enrolled":
      "No second factor is being set up. Start again.",
    "auth.errors.email-unverified":
      "Confirm your e-mail address before setting up a second factor: sign in with the link sent to you.",
    "auth.errors.second-factor-required":
      "This organisation requires a second factor. Set one up to continue.",
    "tenancy.errors.organization-required":
      "Name the organisation in the {header} header.",
    "tenancy.errors.unknown-organization": "This organisation does not exist.",
    "tenancy.errors.slug-taken": 'The address "{slug}" is already taken.',
    "validation.errors.invalid-input": "Some fields are invalid.",
    "validation.errors.required": "This field is required.",
    "validation.errors.invalid": "This value is invalid.",
    "validation.errors.too-short":
      "At least {min, plural, one {# character} other {# characters}} are needed.",
    "validation.errors.too-long":
      "At most {max, plural, one {# character} other {# characters}} are allowed.",
    "validation.errors.out-of-range": "This value is out of range.",
    "projects.errors.not-found": "This project does not exist.",
    "projects.errors.key-taken":
      'The key "{key}" is already used by a project.',
    "projects.errors.status-not-found": "This status does not exist.",
    "projects.errors.status-name-taken":
      'This project already has a status named "{name}".',
    "projects.errors.status-in-use":
      "Issues still use this status. Move them to another status first.",
    "projects.errors.label-not-found": "This label does not exist.",
    "projects.errors.label-name-taken":
      'This project already has a label named "{name}".',
    "issues.errors.not-found": "This issue does not exist.",
    "issues.errors.parent-cycle":
      "An issue cannot be its own parent, nor the parent of one of its parents.",
    "issues.errors.bad-placement":
      "The issues named as neighbours must be in that status, in order.",
    "time.errors.not-linked":
      "This organisation is not linked to chronix: an admin links it first.",
    "time.errors.invalid-key": "chronix refused this link key.",
    "time.errors.unavailable":
      "Time tracking is unavailable right now. Try again in a moment.",
    "time.errors.forbidden":
      "You may not track time in the linked chronix organisation.",
    "time.errors.email-unverified":
      "Your e-mail address is not verified, so time tracking is unavailable. Verify it first, for example by resetting your password.",
    "time.errors.key-mismatch":
      "This chronix key was not made for this organisation of Pulsarix. Create a link key for it in chronix.",
    "time.errors.project-not-mapped":
      "This issue's project is not mapped to a chronix project yet.",
    "time.errors.period-locked": "This date is in a locked chronix period.",
    "time.errors.pulsarix-project-archived":
      "This issue's project is archived: no timer can start and no time can be logged on it.",
    "time.errors.project-archived":
      "The chronix project of this issue's project is archived.",
    "time.errors.project-mapped":
      "This chronix project is already mapped to another project.",
    "time.errors.archived":
      "The project or task of this entry was archived in chronix.",
    "time.errors.catalogue-project-not-found":
      "This chronix project does not exist.",
    "time.errors.rate-limited":
      "Too many time entries: try again in {retryAfter} seconds.",
    "comments.errors.not-found": "This comment does not exist.",
    "comments.errors.not-yours":
      "Only the author or an admin can change this comment.",
    "comments.errors.public-author-only":
      "Only the author can make a comment public or private.",
    "comments.errors.mention-not-member":
      "A mention names someone who is not a member of this organisation.",
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
    "attachments.errors.not-found": "This attachment does not exist.",
    "attachments.errors.too-many":
      "No more than {max} files can be attached here.",
    "attachments.errors.too-large":
      "{reason, select, pixels {This picture is too large: at most {max} megapixels.} other {This file is too large: at most {max} MB.}}",
    "attachments.errors.unsupported-type":
      "Only JPEG, PNG and WebP pictures and PDF files can be attached.",
    "attachments.errors.undecodable": "This file is empty or cannot be read.",
    "attachments.errors.too-small":
      "This picture is too small: its shortest side must be at least {min} pixels.",
    "attachments.errors.unavailable":
      "File storage is temporarily unavailable. Try again shortly.",
    "organisations.errors.too-many":
      "An account can own at most {max, plural, one {# organisation} other {# organisations}}.",
    "members.errors.not-found": "This member does not exist.",
    "members.errors.last-owner":
      "An organisation keeps at least one owner. Name another owner first.",
    "members.errors.owner-required":
      "Only an owner can grant, change or remove the owner role.",
    "invitations.errors.invalid":
      "This invitation is invalid, has expired or has been used.",
    "invitations.errors.not-found": "This invitation does not exist.",
    "invitations.errors.not-pending":
      "This invitation was already accepted or revoked.",
    "invitations.errors.already-member":
      "You are already a member of this organisation.",
    "invitations.errors.address-already-member":
      "This address already belongs to a member of the organisation.",
  },
  fr: {
    "auth.errors.client-header-required":
      "L'en-tête {header} est obligatoire sur chaque requête.",
    "auth.errors.unauthenticated": "Connectez-vous pour continuer.",
    "auth.errors.forbidden": "Vous n'avez pas le droit de faire cela.",
    "auth.errors.unavailable":
      "Le service est momentanément indisponible. Réessayez dans un instant.",
    "auth.errors.invalid-credentials":
      "L'e-mail ou le mot de passe est incorrect.",
    "auth.errors.invalid-token": "Ce lien ou ce code est invalide ou a expiré.",
    "auth.errors.too-many-attempts":
      "Trop de tentatives. Réessayez dans {minutes, plural, one {# minute} other {# minutes}}.",
    "auth.errors.exhausted":
      "La requête est entrée en collision avec d'autres. Réessayez.",
    "auth.errors.step-up-required":
      "Confirmez votre identité pour continuer : demandez un code de confirmation.",
    "auth.errors.invalid-code":
      "Le code est incorrect, expiré ou déjà utilisé.",
    "auth.errors.second-factor-active":
      "Un second facteur est déjà actif. Désactivez-le d'abord.",
    "auth.errors.second-factor-not-enrolled":
      "Aucun second facteur n'est en cours de configuration. Recommencez.",
    "auth.errors.email-unverified":
      "Confirmez votre adresse e-mail avant de configurer un second facteur : connectez-vous avec le lien qui vous a été envoyé.",
    "auth.errors.second-factor-required":
      "Cette organisation exige un second facteur. Configurez-en un pour continuer.",
    "tenancy.errors.organization-required":
      "Indiquez l'organisation dans l'en-tête {header}.",
    "tenancy.errors.unknown-organization": "Cette organisation n'existe pas.",
    "tenancy.errors.slug-taken": "L'adresse « {slug} » est déjà prise.",
    "validation.errors.invalid-input": "Certains champs sont invalides.",
    "validation.errors.required": "Ce champ est obligatoire.",
    "validation.errors.invalid": "Cette valeur est invalide.",
    "validation.errors.too-short":
      "Il faut au moins {min, plural, one {# caractère} other {# caractères}}.",
    "validation.errors.too-long":
      "{max, plural, one {# caractère} other {# caractères}} au maximum.",
    "validation.errors.out-of-range": "Cette valeur est hors limites.",
    "projects.errors.not-found": "Ce projet n'existe pas.",
    "projects.errors.key-taken":
      'La clé "{key}" est déjà utilisée par un projet.',
    "projects.errors.status-not-found": "Ce statut n'existe pas.",
    "projects.errors.status-name-taken":
      'Ce projet a déjà un statut nommé "{name}".',
    "projects.errors.status-in-use":
      "Des tickets utilisent encore ce statut. Déplacez-les d'abord vers un autre statut.",
    "projects.errors.label-not-found": "Ce libellé n'existe pas.",
    "projects.errors.label-name-taken":
      'Ce projet a déjà un libellé nommé "{name}".',
    "issues.errors.not-found": "Ce ticket n'existe pas.",
    "issues.errors.parent-cycle":
      "Un ticket ne peut pas être son propre parent, ni le parent d'un de ses parents.",
    "issues.errors.bad-placement":
      "Les tickets voisins doivent être dans ce statut, dans l'ordre.",
    "time.errors.not-linked":
      "Cette organisation n'est pas reliée à chronix : un administrateur doit d'abord la relier.",
    "time.errors.invalid-key": "chronix a refusé cette clé de liaison.",
    "time.errors.unavailable":
      "Le suivi du temps est indisponible pour le moment. Réessayez dans un instant.",
    "time.errors.forbidden":
      "Vous ne pouvez pas saisir de temps dans l'organisation chronix reliée.",
    "time.errors.email-unverified":
      "Votre adresse e-mail n'est pas vérifiée : le suivi du temps est indisponible. Vérifiez-la d'abord, par exemple en réinitialisant votre mot de passe.",
    "time.errors.key-mismatch":
      "Cette clé chronix n'a pas été créée pour cette organisation de Pulsarix. Créez-en une pour elle dans chronix.",
    "time.errors.project-not-mapped":
      "Le projet de ce ticket n'est pas encore associé à un projet chronix.",
    "time.errors.period-locked":
      "Cette date appartient à une période chronix verrouillée.",
    "time.errors.pulsarix-project-archived":
      "Le projet de ce ticket est archivé : aucun minuteur ne peut démarrer et aucun temps ne peut y être saisi.",
    "time.errors.project-archived":
      "Le projet chronix associé au projet de ce ticket est archivé.",
    "time.errors.project-mapped":
      "Ce projet chronix est déjà associé à un autre projet.",
    "time.errors.archived":
      "Le projet ou la tâche de cette saisie a été archivé dans chronix.",
    "time.errors.catalogue-project-not-found":
      "Ce projet chronix n'existe pas.",
    "time.errors.rate-limited":
      "Trop de saisies de temps : réessayez dans {retryAfter} secondes.",
    "comments.errors.not-found": "Ce commentaire n'existe pas.",
    "comments.errors.not-yours":
      "Seul l'auteur ou un administrateur peut modifier ce commentaire.",
    "comments.errors.public-author-only":
      "Seul l'auteur peut rendre un commentaire public ou privé.",
    "comments.errors.mention-not-member":
      "Une mention désigne quelqu'un qui n'est pas membre de cette organisation.",
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
    "attachments.errors.not-found": "Cette pièce jointe n'existe pas.",
    "attachments.errors.too-many":
      "On ne peut pas joindre plus de {max} fichiers ici.",
    "attachments.errors.too-large":
      "{reason, select, pixels {Cette image est trop grande : {max} mégapixels au plus.} other {Ce fichier est trop volumineux : {max} Mo au plus.}}",
    "attachments.errors.unsupported-type":
      "Seuls les images JPEG, PNG et WebP et les fichiers PDF peuvent être joints.",
    "attachments.errors.undecodable": "Ce fichier est vide ou illisible.",
    "attachments.errors.too-small":
      "Cette image est trop petite : son plus petit côté doit faire au moins {min} pixels.",
    "attachments.errors.unavailable":
      "Le stockage des fichiers est momentanément indisponible. Réessayez dans un instant.",
    "organisations.errors.too-many":
      "Un compte peut posséder au plus {max, plural, one {# organisation} other {# organisations}}.",
    "members.errors.not-found": "Ce membre n'existe pas.",
    "members.errors.last-owner":
      "Une organisation garde au moins un propriétaire. Nommez d'abord un autre propriétaire.",
    "members.errors.owner-required":
      "Seul un propriétaire peut attribuer, changer ou retirer le rôle de propriétaire.",
    "invitations.errors.invalid":
      "Cette invitation est invalide, expirée ou déjà utilisée.",
    "invitations.errors.not-found": "Cette invitation n'existe pas.",
    "invitations.errors.not-pending":
      "Cette invitation a déjà été acceptée ou révoquée.",
    "invitations.errors.already-member":
      "Vous êtes déjà membre de cette organisation.",
    "invitations.errors.address-already-member":
      "Cette adresse appartient déjà à un membre de l'organisation.",
  },
};

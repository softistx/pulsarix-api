import type { Locale } from "./locale";

// The text of the issues module's error codes, in each language; merged into
// `texts` by `texts.ts`.
export const issuesTexts: Record<Locale, Record<string, string>> = {
  en: {
    "issues.errors.not-found": "This issue does not exist.",
    "issues.errors.parent-cycle":
      "An issue cannot be its own parent, nor the parent of one of its parents.",
    "issues.errors.bad-placement":
      "The issues named as neighbours must be in that status, in order.",
    "issues.errors.parent-not-allowed": "An epic cannot have a parent.",
    "issues.errors.parent-type-invalid":
      "This parent does not fit: a story, task or bug can only sit under an epic, and a sub-task only under a story, task or bug.",
    "issues.errors.parent-required":
      "A sub-task needs a parent: a story, a task or a bug.",
    "issues.errors.type-breaks-children":
      "This type would break the link with the issue's child issues. Move or detach them first.",
    "issues.errors.project-archived":
      "This project is archived: its issues, comments and files can no longer be changed. Unarchive it first.",
  },
  fr: {
    "issues.errors.not-found": "Ce ticket n'existe pas.",
    "issues.errors.parent-cycle":
      "Un ticket ne peut pas être son propre parent, ni le parent d'un de ses parents.",
    "issues.errors.bad-placement":
      "Les tickets voisins doivent être dans ce statut, dans l'ordre.",
    "issues.errors.parent-not-allowed": "Une epic ne peut pas avoir de parent.",
    "issues.errors.parent-type-invalid":
      "Ce parent ne convient pas : une story, une tâche ou un bug ne peut dépendre que d'une epic, et une sous-tâche que d'une story, d'une tâche ou d'un bug.",
    "issues.errors.parent-required":
      "Une sous-tâche a besoin d'un parent : une story, une tâche ou un bug.",
    "issues.errors.type-breaks-children":
      "Ce type casserait le lien avec les tickets enfants. Déplacez-les ou détachez-les d'abord.",
    "issues.errors.project-archived":
      "Ce projet est archivé : ses tickets, commentaires et fichiers ne peuvent plus être modifiés. Désarchivez-le d'abord.",
  },
};

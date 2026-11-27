import type { Locale } from "./locale";

// The text of the sprints module's error codes, in each language; merged into
// `texts` by `texts.ts`.
export const sprintsTexts: Record<Locale, Record<string, string>> = {
  en: {
    "sprints.errors.not-found": "This sprint does not exist.",
    "sprints.errors.disabled": "Sprints are turned off for this project.",
    "sprints.errors.active-exists":
      "This project already has an active sprint. Close it first.",
    "sprints.errors.not-active": "Only the active sprint can be closed.",
    "sprints.errors.not-planned":
      "Only a planned sprint can be started, deleted or chosen as the next one.",
    "sprints.errors.closed":
      "A closed sprint can no longer be changed or take issues.",
    "sprints.errors.type-not-allowed":
      "Epics and sub-tasks are not planned: plan their parent story, task or bug.",
    "sprints.errors.active-sprint":
      "Sprints cannot be turned off while one is active. Close it first.",
  },
  fr: {
    "sprints.errors.not-found": "Ce sprint n'existe pas.",
    "sprints.errors.disabled": "Les sprints sont désactivés pour ce projet.",
    "sprints.errors.active-exists":
      "Ce projet a déjà un sprint actif. Clôturez-le d'abord.",
    "sprints.errors.not-active": "Seul le sprint actif peut être clôturé.",
    "sprints.errors.not-planned":
      "Seul un sprint planifié peut être démarré, supprimé ou choisi comme suivant.",
    "sprints.errors.closed":
      "Un sprint clôturé ne peut plus être modifié ni recevoir de tickets.",
    "sprints.errors.type-not-allowed":
      "Les epics et les sous-tâches ne sont pas planifiées : planifiez leur story, tâche ou bug parent.",
    "sprints.errors.active-sprint":
      "Les sprints ne peuvent pas être désactivés tant qu'un sprint est actif. Clôturez-le d'abord.",
  },
};

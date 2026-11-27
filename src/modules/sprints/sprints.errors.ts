import { fail } from "../../core/shared/errors";

// A sprint or issue id sent with a `projectId` that is not its project's.
export const sprintWrongProject = () =>
  fail("sprints.errors.wrong-project", { status: 409, field: "projectId" });

export const sprintNotFound = () =>
  fail("sprints.errors.not-found", { status: 404 });

// The project has sprints turned off (`sprintsEnabled`).
export const sprintsDisabled = () =>
  fail("sprints.errors.disabled", { status: 409 });

// Starting a sprint while another one of the project is active.
export const activeExists = () =>
  fail("sprints.errors.active-exists", { status: 409 });

// Closing a sprint that is not the active one.
export const sprintNotActive = () =>
  fail("sprints.errors.not-active", { status: 409 });

// Starting, deleting or targeting as "next" a sprint that is not planned.
export const sprintNotPlanned = () =>
  fail("sprints.errors.not-planned", { status: 409 });

// A closed sprint takes no change and no new issue.
export const sprintClosed = () =>
  fail("sprints.errors.closed", { status: 409 });

// Epics and sub-tasks are not planned (a sub-task follows its parent).
export const typeNotAllowed = () =>
  fail("sprints.errors.type-not-allowed", { status: 409, field: "ids" });

// Sprints cannot be turned off while one is active.
export const activeSprint = () =>
  fail("sprints.errors.active-sprint", {
    status: 409,
    field: "sprintsEnabled",
  });

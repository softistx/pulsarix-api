// What other modules may import from projects.

export { isProjectArchived } from "./projects.archived";
export { projectNotFound } from "./projects.errors";
export { lockProject } from "./projects.lock";
export type {
  LabelDocument,
  ProjectDocument,
  StatusCategory,
  StatusDocument,
} from "./projects.model";
export {
  type LabelRemoval,
  registerLabelRemoval,
  registerStatusUsage,
  type StatusUsage,
} from "./projects.usage";

// What other modules may import from projects.

export type {
  LabelDocument,
  ProjectDocument,
  StatusCategory,
  StatusDocument,
} from "./projects.model";
export { registerStatusUsage, type StatusUsage } from "./projects.usage";

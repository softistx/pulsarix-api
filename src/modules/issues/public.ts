// What other modules may import from issues.

export { assertProjectWritable } from "./issues.archived";
export { issueNotFound, projectArchived } from "./issues.errors";
export type { ClientMarker, IssueDocument } from "./issues.model";
export type { CreateIssueInput } from "./issues.types";
export {
  type IssueChange,
  type IssueChangeHandler,
  type IssueRemoval,
  issueChanged,
  issueRemoved,
  registerIssueChange,
  registerIssueRemoval,
} from "./issues.usage";
export { IssuesService } from "./services";

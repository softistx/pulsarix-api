// What other modules may import from issues.

export { issueNotFound } from "./issues.errors";
export type { IssueDocument } from "./issues.model";
export { type CreateIssueInput, IssuesService } from "./issues.service";
export {
  type IssueChange,
  type IssueChangeHandler,
  type IssueRemoval,
  issueChanged,
  issueRemoved,
  registerIssueChange,
  registerIssueRemoval,
} from "./issues.usage";

// What other modules may import from issues.

export type { IssueDocument } from "./issues.model";
export { type CreateIssueInput, IssuesService } from "./issues.service";
export {
  type IssueChange,
  type IssueChangeHandler,
  type IssueRemoval,
  issueRemoved,
  registerIssueChange,
  registerIssueRemoval,
} from "./issues.usage";

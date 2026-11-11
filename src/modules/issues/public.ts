// What other modules may import from issues.

export type { IssueDocument } from "./issues.model";
export {
  type IssueRemoval,
  issueRemoved,
  registerIssueRemoval,
} from "./issues.usage";

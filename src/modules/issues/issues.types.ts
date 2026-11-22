import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { FieldChange } from "../../core/shared/changes";
import type {
  IssueDocument,
  IssueType,
  Priority,
  PriorityOrigin,
} from "./issues.model";
import type { IssueChange } from "./issues.usage";

export type IssuesMongo = ModuleMongo<"issues">;

// Whether an account is a member of the organisation: an assignee must be.
export type IsMember = (accountId: string) => Promise<boolean>;

export interface CreateIssueInput {
  projectId: string;
  title: string;
  // Defaults to `task`.
  type?: IssueType | null;
  description?: string | null;
  statusId?: string | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  labelIds?: string[] | null;
  parentId?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  estimateHours?: number | null;
  // Set by the intake module only (never by GraphQL's `CreateIssueInput`): the
  // client report this issue is made from.
  clientReportId?: ObjectId | null;
  // Set by the intake module only: `client` when the priority is the
  // reporter's impact. A member's priority is `team`.
  priorityOrigin?: PriorityOrigin | null;
}

export interface UpdateIssueInput {
  title?: string | null;
  type?: IssueType | null;
  description?: string | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  labelIds?: string[] | null;
  parentId?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  estimateHours?: number | null;
}

// One patch for many issues. A field left out stays; null clears `assigneeId`,
// `dueDate` and `estimateHours`.
export interface BulkUpdateIssueInput {
  statusId?: string | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  addLabelIds?: string[] | null;
  removeLabelIds?: string[] | null;
  dueDate?: Date | null;
  estimateHours?: number | null;
}

export interface BulkIssueFailure {
  id: string;
  code: string;
  message: string;
}

export interface BulkUpdateResult {
  updated: IssueDocument[];
  failures: BulkIssueFailure[];
}

// Tells the registered handlers (the activity journal) what the transaction
// changed; they write inside it.
export type Changed = (
  verb: IssueChange["verb"],
  issue: IssueDocument,
  changes: FieldChange[],
) => Promise<void>;

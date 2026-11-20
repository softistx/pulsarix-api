import type { AnyDb, ModuleMongo } from "../../config/db";
import type { AfterCommit } from "../../core/shared/after-commit";
import type { FieldChange } from "../../core/shared/changes";
import type { IssueDocument } from "./issues.model";

// Tells something outside this module that an issue is going, so that what
// hangs from it goes too (the comments module removes its comments). It runs
// inside the deleting transaction.
export type IssueRemoval = (
  mongo: ModuleMongo<"issues">,
  issueId: string,
) => Promise<void>;

const removals = new Set<IssueRemoval>();

// Registers a removal; the returned function removes it.
export function registerIssueRemoval(removal: IssueRemoval): () => void {
  removals.add(removal);
  return () => {
    removals.delete(removal);
  };
}

export async function issueRemoved(
  mongo: ModuleMongo<"issues">,
  issueId: string,
) {
  for (const removal of removals) await removal(mongo, issueId);
}

// What a write of an issue changed, told to whoever registered for it (the
// activity journal). `issue` is the record after the write (the record as it
// was, for a delete).
export interface IssueChange {
  verb: "created" | "updated" | "moved" | "deleted";
  issue: IssueDocument;
  actorId: string;
  organisationId: string;
  changes: FieldChange[];
}

// Runs inside the writing transaction, so what it writes commits or rolls back
// with the change. It may answer a function to run once the transaction has
// committed (a live event); that one never fails the write.
export type IssueChangeHandler = (
  mongo: AnyDb,
  change: IssueChange,
) => Promise<AfterCommit | undefined>;

const changeHandlers = new Set<IssueChangeHandler>();

// Registers a handler; the returned function removes it.
export function registerIssueChange(handler: IssueChangeHandler): () => void {
  changeHandlers.add(handler);
  return () => {
    changeHandlers.delete(handler);
  };
}

export async function issueChanged(
  mongo: ModuleMongo<"issues">,
  change: IssueChange,
): Promise<AfterCommit[]> {
  const later: AfterCommit[] = [];
  for (const handler of changeHandlers) {
    const afterCommit = await handler(mongo as AnyDb, change);
    if (afterCommit) later.push(afterCommit);
  }
  return later;
}

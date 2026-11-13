import type { ModuleMongo } from "../../config/db";
import type { AfterCommit } from "../../core/shared/after-commit";
import type { FieldChange } from "../../core/shared/changes";
import type { CommentDocument } from "../comments/public";
import type { IssueDocument } from "../issues/public";
import type { ActivityDocument } from "./activity.model";

// A row the journal has just written, with what it records, told to whoever
// registered for it (the notifications). It runs inside the same transaction as
// the change and the row, so what it writes commits or rolls back with them.
export interface ActivityRecorded {
  activity: ActivityDocument;
  organisationId: string;
  // The issue after the change (as it was, for a delete).
  issue: IssueDocument;
  // The comment, for a comment verb.
  comment: CommentDocument | null;
  changes: FieldChange[];
}

export type ActivityRecordedHandler = (
  mongo: ModuleMongo<"activity">,
  recorded: ActivityRecorded,
) => Promise<AfterCommit | undefined>;

const handlers = new Set<ActivityRecordedHandler>();

// Registers a handler; the returned function removes it.
export function registerActivityRecorded(
  handler: ActivityRecordedHandler,
): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export async function activityRecorded(
  mongo: ModuleMongo<"activity">,
  recorded: ActivityRecorded,
): Promise<AfterCommit[]> {
  const later: AfterCommit[] = [];
  for (const handler of handlers) {
    const afterCommit = await handler(mongo, recorded);
    if (afterCommit) later.push(afterCommit);
  }
  return later;
}

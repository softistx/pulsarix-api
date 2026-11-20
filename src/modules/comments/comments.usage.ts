import type { AnyDb, ModuleMongo } from "../../config/db";
import type { AfterCommit } from "../../core/shared/after-commit";
import type { CommentDocument } from "./comments.model";

// What a write of a comment changed, told to whoever registered for it (the
// activity journal). `comment` is the record after the write (as it was, for a
// delete).
export interface CommentChange {
  verb: "commented" | "commentEdited" | "commentDeleted";
  comment: CommentDocument;
  // For an edit: the comment as it was before it.
  previous?: CommentDocument;
  actorId: string;
  organisationId: string;
}

// Runs inside the writing transaction; may answer work to run once it has
// committed (see the issues module's `IssueChangeHandler`).
export type CommentChangeHandler = (
  mongo: AnyDb,
  change: CommentChange,
) => Promise<AfterCommit | undefined>;

const handlers = new Set<CommentChangeHandler>();

// Registers a handler; the returned function removes it.
export function registerCommentChange(
  handler: CommentChangeHandler,
): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export async function commentChanged(
  mongo: ModuleMongo<"comments">,
  change: CommentChange,
): Promise<AfterCommit[]> {
  const later: AfterCommit[] = [];
  for (const handler of handlers) {
    const afterCommit = await handler(mongo as AnyDb, change);
    if (afterCommit) later.push(afterCommit);
  }
  return later;
}

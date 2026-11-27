import type { ObjectId } from "mongodb";
import type { IssuesMongo } from "./issues.types";

// Asks the sprints module which sprint of a project is active, so that the
// issue list's `activeSprint` filter works without this module importing it
// (sprints depends on issues, not the reverse). The sprints module registers
// its own.
export type ActiveSprintOf = (
  mongo: IssuesMongo,
  projectId: ObjectId,
) => Promise<ObjectId | null>;

let source: ActiveSprintOf | null = null;

// Registers the reader; the returned function removes it.
export function registerActiveSprint(of: ActiveSprintOf): () => void {
  source = of;
  return () => {
    if (source === of) source = null;
  };
}

// The active sprint of the project, or null when there is none (or no sprints).
export async function activeSprintOf(
  mongo: IssuesMongo,
  projectId: ObjectId,
): Promise<ObjectId | null> {
  return source ? source(mongo, projectId) : null;
}

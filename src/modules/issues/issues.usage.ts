import type { ModuleMongo } from "../../config/db";

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

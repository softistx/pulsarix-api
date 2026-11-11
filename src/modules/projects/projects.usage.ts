import type { ModuleMongo } from "../../config/db";

export type ProjectsMongo = ModuleMongo<"projects">;

// Asks whether something outside this module still stands on a status. The
// issues module registers its own (A3) so that `deleteStatus` refuses a status
// that issues use (409 `projects.errors.status-in-use`) without this module
// importing it.
// It runs inside the deleting transaction (`mongo` is that transaction, and
// the project is locked), so an issue cannot land on the status meanwhile.
export type StatusUsage = (
  mongo: ProjectsMongo,
  statusId: string,
) => Promise<boolean>;

const usages = new Set<StatusUsage>();

// Registers a check; the returned function removes it.
export function registerStatusUsage(usage: StatusUsage): () => void {
  usages.add(usage);
  return () => {
    usages.delete(usage);
  };
}

export async function statusIsUsed(mongo: ProjectsMongo, statusId: string) {
  for (const usage of usages) {
    if (await usage(mongo, statusId)) return true;
  }
  return false;
}

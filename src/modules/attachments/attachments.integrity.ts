import type { toObjectId } from "@softistx/mongo";
import type { AttachmentsMongo } from "./attachments.service";
import { objectKeys, purge } from "./attachments.store";

// Deletes the records matching `filter` inside the writing transaction and
// answers the purge of their objects, to run once it has committed.
export async function removeFilesWhere(
  mongo: unknown,
  organisationId: string,
  filter:
    | { issueId: ReturnType<typeof toObjectId> }
    | { ownerId: ReturnType<typeof toObjectId> },
) {
  const db = (mongo as AttachmentsMongo).db.attachments;
  const found = await db.findMany({ filter });
  if (found.length === 0) return undefined;
  await db.hardDeleteMany(filter);
  const keys = found.flatMap((file) => objectKeys(organisationId, file));
  return () => purge(keys);
}

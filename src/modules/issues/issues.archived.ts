import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import { isProjectArchived, lockProject } from "../projects/public";
import { projectArchived } from "./issues.errors";

// The ONE guard of the issue writes: refuses (409 `project-archived`) a write
// on an issue, a comment or a file of an archived project. The services call
// it inside their write transaction. `lock` raises the project's version
// first (`lockProject`, as the issues' own writes do), so a transaction that
// only writes comments or files still conflicts with a concurrent archive and
// runs again, seeing it. Without it (a check before an upload) it only reads.
// `mongo` is the organisation's handle or the transaction's.
export async function assertProjectWritable(
  mongo: ModuleMongo<"issues">,
  projectId: ObjectId,
  options: { lock?: boolean } = {},
): Promise<void> {
  if (options.lock) await lockProject(mongo as never, projectId);
  if (await isProjectArchived(mongo, projectId)) throw projectArchived();
}

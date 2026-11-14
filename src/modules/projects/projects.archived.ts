import type { ObjectId } from "mongodb";
import type { ProjectsMongo } from "./projects.usage";

// Whether the project is archived. A missing project counts as not archived:
// the caller's own lookup (the issue's) already refused it.
export async function isProjectArchived(
  mongo: ProjectsMongo,
  projectId: ObjectId,
) {
  const project = await mongo.db.projects.findById(projectId);
  return !!project?.archivedAt;
}

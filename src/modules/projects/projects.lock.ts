import type { ObjectId } from "mongodb";
import { projectNotFound } from "./projects.errors";
import type { ProjectsMongo } from "./projects.usage";

// Locks the project for the transaction: raising its version makes two
// transactions on the same project conflict, the loser running again. Refuses
// (404) a project that does not exist. The workflow's writes use it, and so
// do the issues' (their numbers and ranks are serialised on it).
export async function lockProject(tx: ProjectsMongo, projectId: ObjectId) {
  const project = await tx.db.projects.findById(projectId);
  if (!project) throw projectNotFound();
  await tx.db.projects.update(projectId, { name: project.name });
  return project;
}

import type { ObjectId } from "mongodb";
import type { AnyDb } from "../../../config/db";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../../core/shared/after-commit";
import type { FieldChange } from "../../../core/shared/changes";
import { exhausted } from "../../../core/shared/errors";
import { idOrInvalid } from "../../../core/shared/ids";
import { retryWriteConflicts } from "../../../core/shared/locked";
import { journalOnSprint } from "../../activity/public";
import { projectArchived } from "../../issues/public";
import { lockProject, type ProjectDocument } from "../../projects/public";
import { sprintNotFound, sprintsDisabled } from "../sprints.errors";
import type { SprintDocument } from "../sprints.model";
import type { SprintsMongo } from "../sprints.types";

// What a change of a sprint is called in the project's journal.
export const SPRINT_VERBS = {
  created: "sprintCreated",
  updated: "sprintUpdated",
  started: "sprintStarted",
  closed: "sprintClosed",
  deleted: "sprintDeleted",
} as const;
export type SprintVerb = keyof typeof SPRINT_VERBS;

export type SprintChanged = (
  verb: SprintVerb,
  sprint: SprintDocument,
  changes: FieldChange[],
) => Promise<void>;

// What a write of sprints runs with: the transaction (every collection of the
// organisation), the locked project, what reports a change to the journal and
// what queues work for after the commit.
export interface SprintWork {
  tx: SprintsMongo;
  project: ProjectDocument;
  changed: SprintChanged;
  after: (later: AfterCommit[]) => void;
}

// Every write of a project's sprints runs in one transaction that locks the
// project (as the issues' writes do), so sprint numbers, "one active sprint"
// and the issues' plan ranks are serialised per project.
export class SprintsProject {
  constructor(
    readonly mongo: SprintsMongo,
    readonly viewerId: string,
    readonly organisationId: string,
    readonly timeZone: string,
  ) {}

  async byId(id: string): Promise<SprintDocument> {
    const found = await this.mongo.db.sprints.findById(idOrInvalid(id, "id"));
    if (!found) throw sprintNotFound();
    return found;
  }

  // Runs `work` in a transaction holding the project's lock. The live events
  // of what it reported go out once it has committed (the attempt that
  // committed only). `enabled` refuses (409) a project with sprints off.
  async inProject<T>(
    projectId: ObjectId,
    work: (run: SprintWork) => Promise<T>,
    options: { enabled?: boolean } = {},
  ): Promise<T> {
    let later: AfterCommit[] = [];
    const result = await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          later = [];
          const project = await lockProject(tx, projectId);
          if (project.archivedAt) throw projectArchived();
          if (options.enabled && project.sprintsEnabled !== true) {
            throw sprintsDisabled();
          }
          const changed: SprintChanged = async (verb, sprint, changes) => {
            later.push(
              await journalOnSprint(tx as AnyDb, {
                projectId: sprint.projectId,
                organisationId: this.organisationId,
                actorId: this.viewerId,
                verb: SPRINT_VERBS[verb],
                changes,
              }),
            );
          };
          return work({
            tx,
            project,
            changed,
            after: (more) => later.push(...more),
          });
        }),
      exhausted,
    );
    await runAfterCommit(later);
    return result;
  }
}

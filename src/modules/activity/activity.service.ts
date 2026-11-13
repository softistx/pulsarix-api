import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { FieldChange } from "../../core/shared/changes";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { projectNotFound } from "../projects/public";
import type { ActivityDocument, ActivityVerb } from "./activity.model";

export type ActivityMongo = ModuleMongo<"activity">;

export const MAX_PAGE = 100;

export interface ActivityEntry {
  projectId: ObjectId;
  issueId: ObjectId;
  issueKey: string;
  actorId: string;
  verb: ActivityVerb;
  changes: FieldChange[];
}

// The journal is append-only: this is the only write, and nothing updates or
// deletes a row. Called inside the transaction of the change it records.
export function recordActivity(
  mongo: ActivityMongo,
  entry: ActivityEntry,
): Promise<ActivityDocument> {
  return mongo.db.activities.create({ ...entry, at: new Date() });
}

export interface ActivityPage {
  nodes: ActivityDocument[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface ActivityScope {
  projectId?: string | null | undefined;
  issueId?: string | null | undefined;
}

// The journal of a project or of one issue, newest first, paged by cursor.
export class ActivityService {
  constructor(private readonly mongo: ActivityMongo) {}

  async list(
    scope: ActivityScope,
    first: number | null | undefined,
    after?: string | null,
  ): Promise<ActivityPage> {
    if (Boolean(scope.projectId) === Boolean(scope.issueId)) {
      throw invalid([{ path: "projectId", code: "validation.errors.invalid" }]);
    }
    const limit = first ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw invalid([
        { path: "first", code: "validation.errors.out-of-range" },
      ]);
    }
    // An unknown project is a 404; an issue is not looked up, so the history
    // of a deleted one stays readable.
    if (
      scope.projectId &&
      !(await this.mongo.db.projects.exists({
        _id: idOrInvalid(scope.projectId, "projectId"),
      }))
    ) {
      throw projectNotFound();
    }
    const cursor = after ? idOrInvalid(after, "after") : null;
    const found = await this.mongo.db.activities.findMany({
      filter: {
        ...(scope.projectId && {
          projectId: idOrInvalid(scope.projectId, "projectId"),
        }),
        ...(scope.issueId && {
          issueId: idOrInvalid(scope.issueId, "issueId"),
        }),
        ...(cursor && { _id: { $lt: cursor } }),
      },
      sort: { _id: -1 },
      limit: limit + 1,
    });
    const nodes = found.slice(0, limit);
    const last = nodes.at(-1);
    const hasNextPage = found.length > limit;
    return {
      nodes,
      endCursor: hasNextPage && last ? last.id : null,
      hasNextPage,
    };
  }
}

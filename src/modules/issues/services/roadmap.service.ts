import { toObjectId } from "@softistx/mongo";
import { grouped, idOrInvalid } from "../../../core/shared/ids";
import type { IssueDocument } from "../issues.model";
import { noEpicTypes } from "../issues.query";
import {
  type RoadmapFacts,
  type RoadmapIssue,
  roadmapFacts,
} from "../issues.rules";
import type { IssuesMongo } from "../issues.types";

export interface RoadmapRowView extends RoadmapFacts {
  epic: IssueDocument | null;
}

export interface Roadmap {
  epics: RoadmapRowView[];
  undated: RoadmapRowView[];
  noEpic: RoadmapRowView;
}

// The roadmap of a project (plan §20.5): its Epics with their date range and
// progress, and the issues that have no Epic as one more row. Four reads
// whatever the number of Epics: the Epics, their children, the issues with no
// Epic, and the statuses.
export class RoadmapService {
  constructor(private readonly mongo: IssuesMongo) {}

  async of(projectId: string): Promise<Roadmap> {
    const id = idOrInvalid(projectId, "projectId");
    const [found, loose, statuses] = await Promise.all([
      this.mongo.db.issues.findMany({
        filter: { projectId: id, type: "epic" } as never,
      }),
      this.mongo.db.issues.findMany({
        filter: {
          projectId: id,
          type: { $in: noEpicTypes },
          parentId: null,
        } as never,
      }),
      this.mongo.db.statuses.findMany({ filter: { projectId: id } }),
    ]);
    const category = new Map(
      statuses.map((status) => [status.id, status.category]),
    );
    const view = (issue: IssueDocument): RoadmapIssue => ({
      category: category.get(issue.statusId.toHexString()) ?? "",
      start: issue.startDate ?? null,
      due: issue.dueDate ?? null,
      points: issue.points ?? null,
    });
    const rowOf = (
      epic: IssueDocument | null,
      own: IssueDocument[],
    ): RoadmapRowView => ({
      epic,
      ...roadmapFacts(epic && view(epic), own.map(view)),
    });
    const epics = found.filter((epic) => view(epic).category !== "cancelled");
    const children = await this.mongo.db.issues.findMany({
      filter: {
        parentId: { $in: epics.map((epic) => toObjectId(epic.id)) },
      } as never,
    });
    const own = grouped(
      epics.map((epic) => epic.id),
      children,
      (child) => child.parentId?.toHexString() ?? "",
    );
    const rows = epics.map((epic, i) => rowOf(epic, own[i] ?? []));
    return {
      epics: rows.filter((row) => row.start !== null || row.end !== null),
      undated: rows.filter((row) => row.start === null && row.end === null),
      noEpic: rowOf(null, loose),
    };
  }
}

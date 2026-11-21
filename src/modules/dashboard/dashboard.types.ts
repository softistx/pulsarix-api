import type { ObjectId } from "mongodb";
import type { ProjectDocument, StatusDocument } from "../projects/public";

// What every section reads first: the active projects (by name) and their
// statuses, split into the open ones (not done, not cancelled) and the triage
// ones. Read once per request, by the first section that asks.
export interface Base {
  projects: ProjectDocument[];
  statuses: Map<string, StatusDocument>;
  openIds: ObjectId[];
  triageIds: ObjectId[];
}

// What one project shows on the dashboard: its open, urgent, late and triage
// issues.
export interface FigureRow {
  _id: ObjectId;
  open: number;
  urgent: number;
  late: number;
  triage: number;
}

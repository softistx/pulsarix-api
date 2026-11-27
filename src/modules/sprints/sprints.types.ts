import type { ModuleMongo } from "../../config/db";

export type SprintsMongo = ModuleMongo<"sprints">;

// One day of a sprint's burndown. The figures are null for a day that has not
// come yet.
export interface BurndownPoint {
  day: string;
  ideal: number;
  remainingPoints: number | null;
  scopePoints: number | null;
  completedPoints: number | null;
}

export interface SprintBurndown {
  sprintId: string;
  committedPoints: number;
  timeZone: string;
  points: BurndownPoint[];
}

export interface VelocitySprint {
  sprintId: string;
  number: number;
  name: string;
  committedPoints: number;
  completedPoints: number;
  closedAt: Date | null;
}

export interface Velocity {
  sprints: VelocitySprint[];
  average: number;
}

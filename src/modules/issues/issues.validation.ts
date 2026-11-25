import type { ObjectId } from "mongodb";
import type { FieldIssue } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { pointsOffScale } from "./issues.errors";
import { pointScale } from "./issues.model";

// The ids given, as ObjectIds, each once.
export const distinct = (given: string[], path: string): ObjectId[] => {
  const seen = new Map<string, ObjectId>();
  for (const id of given) {
    const objectId = idOrInvalid(id, path);
    seen.set(objectId.toHexString(), objectId);
  }
  return [...seen.values()];
};

// An estimate is a number of hours, 0 to 100 000.
export const estimateIssue = (
  hours: number | null | undefined,
): FieldIssue[] =>
  hours !== undefined && hours !== null && !(hours >= 0 && hours <= 100_000)
    ? [{ path: "estimateHours", code: "validation.errors.out-of-range" }]
    : [];

// Story points are on the Fibonacci scale or none: 400 `points-off-scale`.
export const checkScale = (points: number | null | undefined): void => {
  if (
    points !== undefined &&
    points !== null &&
    !(pointScale as readonly number[]).includes(points)
  ) {
    throw pointsOffScale();
  }
};

export const invalidField = (path: string): FieldIssue => ({
  path,
  code: "validation.errors.invalid",
});

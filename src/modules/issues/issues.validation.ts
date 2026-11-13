import type { ObjectId } from "mongodb";
import type { FieldIssue } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";

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
  hours != null && !(hours >= 0 && hours <= 100_000)
    ? [{ path: "estimateHours", code: "validation.errors.out-of-range" }]
    : [];

export const invalidField = (path: string): FieldIssue => ({
  path,
  code: "validation.errors.invalid",
});

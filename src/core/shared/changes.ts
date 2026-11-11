import { ObjectId } from "mongodb";

// One field of a record that a write changed, as the activity journal and the
// live events say it: values as text (`null` for none), lists as JSON text, a
// long text clipped.
export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

const CLIP = 500;

// A value as text: ids and dates in their text form, a list as JSON, a text
// longer than 500 characters cut with an ellipsis.
export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = (() => {
    if (value instanceof ObjectId) return value.toHexString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return JSON.stringify(value.map(asPlain));
    return String(value);
  })();
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

const asPlain = (value: unknown): unknown =>
  value instanceof ObjectId
    ? value.toHexString()
    : value instanceof Date
      ? value.toISOString()
      : value;

// The `fields` that differ between two versions of a record.
export function changesBetween<T extends object>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    const from = asText(before[field]);
    const to = asText(after[field]);
    // Compare the full values, not the clipped text, for a long description.
    if (
      JSON.stringify(asPlainDeep(before[field])) ===
      JSON.stringify(asPlainDeep(after[field]))
    )
      continue;
    changes.push({ field, from, to });
  }
  return changes;
}

const asPlainDeep = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(asPlain) : asPlain(value);

// The fields of a new record, as changes from nothing.
export function changesFromNothing<T extends object>(
  record: T,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  return fields.flatMap((field) => {
    const to = asText(record[field]);
    return to === null || to === "[]" ? [] : [{ field, from: null, to }];
  });
}

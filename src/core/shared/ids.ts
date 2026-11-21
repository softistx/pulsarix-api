import { ObjectId } from "mongodb";
import { invalid } from "./errors";

// A MongoDB ObjectId as text: 24 hex digits, any case.
export const OBJECT_ID = /^[0-9a-f]{24}$/i;

// The id of a mutation's `id`: an ObjectId, or `validation.errors.invalid` on
// `path` (400) when it is malformed.
export function idOrInvalid(given: string, path = "id"): ObjectId {
  if (!OBJECT_ID.test(given)) {
    throw invalid([{ path, code: "validation.errors.invalid" }]);
  }
  return new ObjectId(given);
}

// The rows of each key, in the order of `keys` (a DataLoader batch's answer):
// `keyOf` gives the key a row belongs to; a key with no row gets `[]`.
export function grouped<Row>(
  keys: readonly string[],
  rows: readonly Row[],
  keyOf: (row: Row) => string,
): Row[][] {
  const byKey = new Map<string, Row[]>(keys.map((key) => [key, []]));
  for (const row of rows) byKey.get(keyOf(row))?.push(row);
  return keys.map((key) => byKey.get(key) ?? []);
}

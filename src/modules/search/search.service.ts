import type { ModuleMongo } from "../../config/db";

export type SearchMongo = ModuleMongo<"search">;

export const MAX_QUERY = 200;
export const MAX_FIRST = 50;

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An issue key as typed: `abc-12`, any case.
const KEY = /^[a-z][a-z0-9]{1,9}-\d{1,9}$/i;

export const issueKeyOf = (query: string) =>
  KEY.test(query) ? query.toUpperCase() : null;

interface Searchable {
  _id: { equals(other: unknown): boolean };
}

// The text-index hits (best score first), then, while the page is not full,
// the documents whose `fields` contain the query as typed, newest first: a
// text index matches whole words, and a command palette types prefixes. A
// document found twice keeps its first place.
export async function ranked<D extends Searchable>(
  query: string,
  first: number,
  find: {
    text(limit: number): Promise<D[]>;
    contains(pattern: RegExp, limit: number): Promise<D[]>;
  },
  head: D[] = [],
): Promise<D[]> {
  const found: D[] = [...head];
  const add = (more: D[]) => {
    for (const doc of more) {
      if (found.length >= first) return;
      if (!found.some((seen) => seen._id.equals(doc._id))) found.push(doc);
    }
  };
  add(await find.text(first + head.length));
  if (found.length < first) {
    add(
      await find.contains(
        new RegExp(escapeRegex(query), "i"),
        first + head.length,
      ),
    );
  }
  return found;
}

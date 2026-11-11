import type { IssueDocument } from "../issues/public";
import { issueKeyOf, ranked, type SearchMongo } from "./search.service";

// Issues by relevance: an exact key first, then the text index (title and key
// weigh more than the description), then a substring of the title or key.
export async function searchIssues(
  mongo: SearchMongo,
  query: string,
  first: number,
): Promise<IssueDocument[]> {
  const key = issueKeyOf(query);
  const exact = key ? await mongo.db.issues.findFirst({ key }) : undefined;
  return ranked(
    query,
    first,
    {
      text: (limit) =>
        mongo.db.issues.findMany({
          filter: { $text: { $search: query, $language: "none" } } as never,
          sort: { score: { $meta: "textScore" } } as never,
          limit,
        }),
      contains: (pattern, limit) =>
        mongo.db.issues.findMany({
          filter: { $or: [{ title: pattern }, { key: pattern }] } as never,
          sort: { updatedAt: -1 } as never,
          limit,
        }),
    },
    exact ? [exact] : [],
  );
}

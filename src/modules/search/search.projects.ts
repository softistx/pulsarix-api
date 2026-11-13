import type { ProjectDocument } from "../projects/public";
import { ranked, type SearchMongo } from "./search.service";

// Projects by relevance: the text index (key and name weigh more than the
// description), then a substring of the key or name. Archived projects are
// found too, as the `archivedAt` they carry says.
export function searchProjects(
  mongo: SearchMongo,
  query: string,
  first: number,
): Promise<ProjectDocument[]> {
  return ranked(query, first, {
    text: (limit) =>
      mongo.db.projects.findMany({
        filter: { $text: { $search: query, $language: "none" } } as never,
        sort: { score: { $meta: "textScore" } } as never,
        limit,
      }),
    contains: (pattern, limit) =>
      mongo.db.projects.findMany({
        filter: { $or: [{ name: pattern }, { key: pattern }] } as never,
        sort: { updatedAt: -1 } as never,
        limit,
      }),
  });
}

import type { ObjectId } from "mongodb";
import type { AnyDb, ModuleMongo } from "../../config/db";
import type { CommentDocument } from "./comments.model";

// An entry of the team's comment list that is not a stored comment: what a
// reporter wrote in a request thread (plan §19, flow 4), built from the
// reporter's messages and never stored a second time. It is read only: it has
// no author, is never `public`, and no mutation finds it.
export interface ClientEntry {
  id: string;
  _id: ObjectId;
  issueId: ObjectId;
  authorId: null;
  body: string;
  mentionIds: readonly string[];
  public: false;
  editedAt: null;
  createdAt: Date;
  updatedAt: Date;
  source: "CLIENT";
  reportId: string;
  reporterName: string | null;
}

export type CommentEntry = CommentDocument | ClientEntry;

export const isClientEntry = (entry: CommentEntry): entry is ClientEntry =>
  "source" in entry;

// What a source is asked: the entries of one issue after a cursor, oldest
// first, at most `limit`.
export interface SourceQuery {
  issueId: ObjectId;
  after: ObjectId | null;
  limit: number;
}

export type CommentSource = (
  mongo: AnyDb,
  query: SourceQuery,
) => Promise<ClientEntry[]>;

const sources = new Set<CommentSource>();

// Registers a source (the intake module's reporter messages); the returned
// function removes it.
export function registerCommentSource(source: CommentSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

// The comments of an issue with every source's entries merged in, oldest
// first by id (an ObjectId's order is the creation order, in both
// collections), at most `limit`.
export async function mergedEntries(
  mongo: ModuleMongo<"comments">,
  query: SourceQuery,
): Promise<CommentEntry[]> {
  const stored = await mongo.db.comments.findMany({
    filter: {
      issueId: query.issueId,
      ...(query.after && { _id: { $gt: query.after } }),
    },
    sort: { _id: 1 },
    limit: query.limit,
  });
  const extra = await Promise.all(
    [...sources].map((source) => source(mongo as AnyDb, query)),
  );
  return [...stored, ...extra.flat()]
    .sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString()))
    .slice(0, query.limit);
}

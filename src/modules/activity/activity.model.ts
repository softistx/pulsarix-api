import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

export const activityVerb = z.enum([
  "created",
  "updated",
  "moved",
  "deleted",
  "commented",
  "commentEdited",
  "commentDeleted",
  // A reporter wrote in the thread of one of the issue's client reports.
  "clientReplied",
]);
export type ActivityVerb = z.infer<typeof activityVerb>;

// One field that a change touched, as text (`null` for none).
export const activityChange = z.object({
  field: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

// The append-only journal of a project's changes, in the organisation's
// database. A row is written in the transaction of the change it records and
// is never updated or deleted (the module's service has no such method), so a
// deleted issue keeps its history. `issueKey` is the issue's key at that time.
export const activities = defineCollection({
  name: "activities",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    issueId: objectId().nullable().default(null),
    issueKey: z.string().nullable().default(null),
    actorId: accountId,
    verb: activityVerb,
    changes: z.array(activityChange).default([]),
    at: z.date(),
  }),
  timestamps: true,
  actors,
  indexes: [
    { key: { projectId: 1, _id: -1 }, name: "activities_projectIdId" },
    { key: { issueId: 1, _id: -1 }, name: "activities_issueIdId" },
  ],
});
export type ActivityDocument = ReadDocumentOf<typeof activities>;

import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../core/shared/actors";

// The key of a project, the prefix of its issues (`ABC-1`): 2 to 10 capital
// letters and digits, starting with a letter. One regex, so the collection's
// validator carries it as well.
export const projectKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);

// A colour as `#rrggbb`.
export const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// The categories of a workflow, in the order a default workflow lists them.
// `triage` holds what intake brings in before a member accepts it.
export const statusCategory = z.enum([
  "triage",
  "backlog",
  "todo",
  "inProgress",
  "done",
  "cancelled",
]);
export type StatusCategory = z.infer<typeof statusCategory>;

// What a reporter sees of a status (plan §19): four fixed states, whatever the
// workflow's own names are. The names themselves never leave the team.
export const publicState = z.enum([
  "received",
  "inProgress",
  "resolved",
  "declined",
]);
export type PublicState = z.infer<typeof publicState>;

// The state a category maps to until the team sets one.
export const defaultPublicState: Record<StatusCategory, PublicState> = {
  triage: "received",
  backlog: "received",
  todo: "received",
  inProgress: "inProgress",
  done: "resolved",
  cancelled: "declined",
};

// The state of a status: its own, or its category's. Statuses stored before
// widget v3 lack the field (the mongo layer applies no schema default on read),
// so every reader goes through this.
export const publicStateOfStatus = (status: {
  category: StatusCategory;
  publicState?: PublicState | null | undefined;
}): PublicState => status.publicState ?? defaultPublicState[status.category];

// A project, in the organisation's database: the key is unique there, so
// unique per organisation (the database is the organisation's). The key is
// fixed when the project is made, since the issues' keys derive from it.
export const projects = defineCollection({
  name: "projects",
  schema: z.object({
    _id: id(),
    key: projectKey,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(""),
    // The account leading the project, a member of the organisation.
    leadId: accountId.nullable().default(null),
    visibility: z.enum(["organisation"]).default("organisation"),
    archivedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { key: 1 }, unique: true, name: "projects_keyUnique" },
    // Search (A8): no stemming nor stop words, so French and English alike.
    {
      key: { key: "text", name: "text", description: "text" },
      weights: { key: 10, name: 10, description: 1 },
      default_language: "none",
      name: "projects_text",
    },
  ],
});
export type ProjectDocument = ReadDocumentOf<typeof projects>;

// A step of a project's workflow. `order` is its place, 0-based and gap-free
// (`reorderStatuses` rewrites it as a whole).
export const statuses = defineCollection({
  name: "statuses",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    name: z.string().trim().min(1).max(100),
    category: statusCategory,
    // Shown to the reporter in its place; absent until set (see above).
    publicState: publicState.optional(),
    order: z.number().int().min(0),
    colour,
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { projectId: 1, order: 1 }, name: "statuses_projectIdOrder" },
    {
      key: { projectId: 1, name: 1 },
      unique: true,
      name: "statuses_projectIdNameUnique",
    },
  ],
});
export type StatusDocument = ReadDocumentOf<typeof statuses>;

export const labels = defineCollection({
  name: "labels",
  schema: z.object({
    _id: id(),
    projectId: objectId(),
    name: z.string().trim().min(1).max(100),
    colour,
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { projectId: 1, name: 1 },
      unique: true,
      name: "labels_projectIdNameUnique",
      // Case-insensitive, as the lookups are ("bug" and "Bug" are one label):
      // sync rebuilds the index when its options change.
      collation: { locale: "en", strength: 2 },
    },
  ],
});
export type LabelDocument = ReadDocumentOf<typeof labels>;

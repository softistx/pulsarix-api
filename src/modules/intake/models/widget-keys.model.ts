import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { actors } from "../../../core/shared/actors";

// What a widget key is spelled like: `pk_live_` and 32 URL-safe characters
// (192 bits). Public by design (plan §11): it names a project, it opens nothing.
export const PUBLIC_KEY = /^pk_live_[A-Za-z0-9_-]{32}$/;

// An origin as a browser sends it in `Origin`: scheme, host and port, nothing
// else, in the one text `URL.origin` gives.
export const origin = z.string().min(8).max(200);

// A widget key, in the CORE database: the public endpoint finds the
// organisation and the project of a key before it knows which organisation
// database to open (plan §6, "the widget-key index"), and the team lists and
// edits the same documents. `allowedOrigins` is required (at least one);
// `active` is the admin's "disable key" switch (the key answers `enabled:
// false`); `revokedAt` retires the key for good (it answers like an unknown
// one). `lastUsedAt` is kept to the minute.
export const widgetKeys = defineCollection({
  name: "widgetKeys",
  schema: z.object({
    _id: id(),
    organisationId: objectId(),
    projectId: objectId(),
    publicKey: z.string().regex(PUBLIC_KEY),
    label: z.string().trim().min(1).max(100),
    allowedOrigins: z.array(origin).min(1).max(20),
    active: z.boolean().default(true),
    // "Screenshots and files": off, the key takes no file (A12).
    attachmentsEnabled: z.boolean().default(true),
    // Counters of the key's file traffic (A13), shown on the key's page:
    // files stored, and refusals by reason (the code's slug, from a closed list:
    // services/counters.service.ts). Raw `$inc`s: they do not touch `version`.
    uploads: z.number().int().min(0).default(0),
    refusals: z.record(z.string(), z.number().int().min(0)).default({}),
    // The secret the host signs identity tokens with (plan §19): sealed with
    // the application's sealing keys, bound to the key's id (services/identity.service.ts),
    // never returned after it was shown once. Null until generated; keys stored
    // before widget v3 lack both fields.
    identitySecret: z.string().min(1).nullable().default(null),
    identitySecretSetAt: z.date().nullable().default(null),
    revokedAt: z.date().nullable().default(null),
    lastUsedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { publicKey: 1 }, unique: true, name: "widgetKeys_publicKeyUnique" },
    {
      key: { organisationId: 1, projectId: 1, _id: 1 },
      name: "widgetKeys_organisationIdProjectId",
    },
    // The preflight asks whether any live key allows an origin.
    { key: { allowedOrigins: 1 }, name: "widgetKeys_allowedOrigins" },
  ],
});
export type WidgetKeyDocument = ReadDocumentOf<typeof widgetKeys>;

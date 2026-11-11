import { z } from "zod";

// Who wrote a document (`createdBy`, `updatedBy`, `deletedBy`): a janus
// account id, a UUIDv7 string. Every collection stamps the same type, so
// `mongo.as(viewer.id)` stamps them all, in the core database and in an
// organization's alike.
export const accountId = z.uuid();

export const actors = { type: accountId };

// Who stamps the writes of a script no account runs (`bun run db:*`, a demo
// seed): a fixed UUIDv7-shaped id, no janus account.
export const SYSTEM_ACTOR = "00000000-0000-7000-8000-000000000000";

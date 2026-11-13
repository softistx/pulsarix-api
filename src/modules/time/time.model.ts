import { defineCollection, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { actors } from "../../core/shared/actors";

// The organisation's chronix link, ONE document (`_id` "main") in the
// organisation's database. `sealedKey` is the link key sealed with the
// application's keys (time.seal.ts); it never leaves the API. Time itself
// (entries, totals) is chronix's: pulsarix stores none.
export const timeLinks = defineCollection({
  name: "timeLinks",
  schema: z.object({
    _id: z.literal("main"),
    sealedKey: z.string().min(1),
    // The chronix organisation's name, read when the key was checked.
    organisationName: z.string().min(1).max(200),
  }),
  timestamps: true,
  actors,
});
export type TimeLinkDocument = ReadDocumentOf<typeof timeLinks>;

// What `Issue.timeSpent` hands its fields: the issue it is for (read by
// `myRunningTimer`) beside the numbers.
export interface TimeSpentParent {
  issueId: string;
  status: "AVAILABLE" | "UNLINKED" | "UNAVAILABLE" | "FORBIDDEN";
  totalSeconds: number | null;
  mySeconds: number | null;
  entryCount: number | null;
  running: boolean | null;
}

import { defineCollection } from "@softistx/mongo";
import { z } from "zod";

// The lock document of an organisation's members, in the core database: one
// per organisation, `_id` being its id. Every change that may take an owner
// away raises `version` inside a transaction first, so two at once conflict on
// it and the loser runs again once the winner committed (the last-owner rule).
// Created on first use, never deleted.
export const memberLocks = defineCollection({
  name: "memberLocks",
  schema: z.object({
    _id: z.string(),
    version: z.number().int().default(0),
  }),
});

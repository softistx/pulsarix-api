import type { createMongoAdapter } from "@softistx/janus-mongo";
import { membershipReads } from "./reads";
import type { JanusMembership, Permissions } from "./types";
import { membershipWrites } from "./writes";

export type { JanusMembership } from "./types";

type Relations = ReturnType<typeof createMongoAdapter>["relations"];

// Membership over janus's relations (see `JanusMembership`): the reads every
// request needs (reads.ts), and the writes of a role (writes.ts), which keep
// ONE role per organisation. The members module lists, changes and removes
// members on top of it, with the last-owner guard.
export function janusMembership(
  permissions: Permissions,
  relations: Relations,
  options: { warn?: (message: string) => void } = {},
): JanusMembership {
  const warn = options.warn ?? ((message) => console.warn(message));
  return {
    ...membershipReads(permissions, relations, warn),
    ...membershipWrites(relations),
  };
}

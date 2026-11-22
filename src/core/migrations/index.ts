import { issueTypes } from "./2026-11-21-issue-types.migration";

// The data migrations, in EXECUTION order: the only list `provision` and `migrateAtBoot`
// read: run on every organisation database and recorded
// there by id (`nxgt_migrations`). It only grows: a migration is appended at
// the end, and a merged one is never edited, reordered or removed (a fix is a
// new migration). A migration imports no module (models evolve): it writes
// through the driver's `Db`, in the transaction `migrate` gives it.
export const migrations = [issueTypes];

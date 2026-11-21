import { dbOf } from "@softistx/alxia-tenancy";
import { syncMongoAdapter } from "@softistx/janus-mongo";
import type { CoreMongo } from "./db";

/**
 * Brings the core database's validators and indexes up to date: the modules'
 * own core collections (`coreMongo.sync()`) and janus's (users, sessions,
 * tokens, relations: `syncMongoAdapter`). It is what `tenancy.sync()` does for
 * the core, without its loop over every organisation database (those sync
 * themselves on first use, MONGO_AUTO_SYNC). Idempotent: collMod and
 * createIndexes, an index is rebuilt only when its options changed, nothing is
 * dropped otherwise. Never `syncAll` here (see `tenancyOf`).
 */
export async function syncCoreDatabase(core: CoreMongo): Promise<void> {
  await core.sync();
  await syncMongoAdapter(dbOf(core));
}

/**
 * Runs the sync at boot, before the server listens. A failure is logged with
 * its cause and ends the process (exit 1), so a deploy's healthcheck fails
 * rather than serving against a stale schema.
 */
export async function syncCoreAtBoot(
  core: CoreMongo,
  exit: (code: number) => never = process.exit,
  sync: (core: CoreMongo) => Promise<void> = syncCoreDatabase,
): Promise<void> {
  try {
    await sync(core);
    console.log("pulsarix-api: core database validators and indexes synced");
  } catch (error) {
    console.error(
      "pulsarix-api: core database sync failed, not starting:",
      error,
    );
    exit(1);
  }
}

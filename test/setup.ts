import { afterAll } from "bun:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

// Preloaded by `bun test` (bunfig.toml), before any spec imports src/: one
// in-memory MongoDB, a one-node replica set so that transactions work, for the
// whole run. src/config/env.ts then reads its URI as MONGO_URI; the core
// database and the organisation databases are named by the defaults
// (pulsarix_core, pulsarix_org_<id>), on that one server. Nothing here needs
// Docker or the developer's .env, so CI runs the same specs.
const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
  instanceOpts: [
    {
      args: [
        "--wiredTigerCacheSizeGB=1",
        "--setParameter=diagnosticDataCollectionEnabled=false",
      ],
    },
  ],
});
Bun.env["MONGO_URI"] = replSet.getUri();

// Specs mail through a memory mailer they inject (test/auth.ts), never through
// an SMTP server of the developer's .env.
delete Bun.env["MAIL_URL"];

// janus's collections (users, sessions, tokens, relations) in the core
// database, as the tenancy store syncs them: autoSync does not know them, and a
// write inside a transaction to a collection not yet created would hang.
{
  const { coreMongo } = await import("../src/config/db");
  const { syncMongoAdapter } = await import("@softistx/janus-mongo");
  const { dbOf } = await import("@alxia/tenancy");
  await coreMongo.sync();
  await syncMongoAdapter(dbOf(coreMongo));
}

afterAll(async () => {
  const { closeDatabases } = await import("../src/config/db");
  await closeDatabases();
  await replSet.stop();
});

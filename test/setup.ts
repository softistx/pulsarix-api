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

// Live events run in the one process (local channels), never through the
// developer's Redis.
delete Bun.env["REDIS_URL"];

// janus's collections (users, sessions, tokens, relations) in the core
// database, as the tenancy store syncs them: autoSync does not know them, and a
// write inside a transaction to a collection not yet created would hang.
{
  const { coreMongo } = await import("../src/config/db");
  const { syncCoreDatabase } = await import("../src/config/core-sync");
  await syncCoreDatabase(coreMongo);
}

// Its own timeout, not the specs' 15 s: removing the server's data directory
// (thousands of organisation tables' files) takes 9 s after the four intake
// specs alone on a loaded laptop, and more after the whole suite.
afterAll(async () => {
  const { closeDatabases } = await import("../src/config/db");
  await closeDatabases();
  await discard(replSet);
}, 120_000);

// The server and its files are thrown away, so it is killed rather than shut
// down: a clean shutdown ends with a WiredTiger checkpoint of every collection
// and index the run made, which grows with the suite and the machine's load.
// Past 10 s, mongodb-memory-server falls back to SIGKILL anyway ("A
// child-process didnt exit with signal SIGINT"). `stop` then only stops the
// killer process and removes the data directory.
async function discard(set: MongoMemoryReplSet) {
  await Promise.all(
    set.servers.map(async (server) => {
      const mongod = server.instanceInfo?.instance.mongodProcess;
      if (!mongod || mongod.exitCode !== null || mongod.signalCode !== null) {
        return;
      }
      const exited = new Promise((resolve) => mongod.once("exit", resolve));
      mongod.kill("SIGKILL");
      await exited;
    }),
  );
  await set.stop();
}

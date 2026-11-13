import {
  type CollectionsOf,
  type CoreCollectionsOf,
  collectionsOf,
  coreCollectionsOf,
  type Module,
  type ModuleHandle,
  type ModuleName,
} from "@alxia/modules";
import { createTenantDatabases, dbOf, perOrganization } from "@alxia/tenancy";
import { syncMongoAdapter } from "@softistx/janus-mongo";
import {
  connectMongo,
  defineMongo,
  type MongoOf,
  openMongo,
} from "@softistx/mongo";
import type { Membership } from "../core/access";
import { organisationRegistry } from "../core/tenancy";
import { modules } from "../modules/registry";
import { autoSyncOf } from "./auto-sync";
import { env } from "./env";

// ONE MongoClient for the whole process (connectMongo shares it per URI), never
// one per organisation. The core `Mongo` and every organisation's are opened on
// it with `client`, which they never close: `closeDatabases` below does.
const connection = await connectMongo(env.MONGO_URI, {
  appName: "pulsarix-api",
});

// Development and tests create the validators and indexes before a collection's
// first use. In production they do not, unless MONGO_AUTO_SYNC=true (deploy/: the
// API's Mongo user holds the dbAdmin role, so each organisation database made
// at runtime gets its validators and indexes on first use).
const autoSync = autoSyncOf(
  Bun.env.NODE_ENV === "production",
  env.MONGO_AUTO_SYNC,
);

// The core database: the organisation registry, the member locks, the
// invitations and janus's own collections (users, sessions, tokens,
// relations), shared by every organisation. Its collections are the modules'
// `coreCollections` (the registry is the only list, src/modules/registry.ts).
export const mongoConfig = defineMongo({
  client: connection.client,
  database: env.MONGO_CORE_DATABASE,
  collections: coreCollectionsOf(modules) as CoreCollectionsOf,
  autoSync,
});

export type CoreMongo = MongoOf<typeof mongoConfig>;

export const coreMongo: CoreMongo = await openMongo(mongoConfig);

// The organisation handles' cache: one per module list, made by
// `createTenantDatabases`. The registry's is the process's (`databases`, shared
// by the stores below and closed once by `closeDatabases`).
function databasesOf(list: readonly Module[]) {
  return createTenantDatabases({
    database: env.MONGO_ORGANISATION_PREFIX,
    size: env.MONGO_ORGANISATION_CACHE_SIZE,
    configure: (database) =>
      defineMongo({
        client: connection.client,
        database,
        collections: collectionsOf(list) as CollectionsOf,
        autoSync,
      }),
  });
}

export const databases = databasesOf(modules);

// The tenancy store (@alxia/tenancy `perOrganization`): the core database
// above plus one database per organisation, `<prefix><id>`, with the
// collections the modules declare as `collections`. A resolver reaches a
// database through the request's scope, never by building a name. The store
// syncs janus's collections in the core database (`syncCore`, never an
// organisation's). `membership` is what a request's scope asks: the viewer's
// role in an organisation, or null for a non-member.
export function tenancyOf(
  membership: Membership,
  // A spec plugs a sample module in beside the registry's; that list gets its
  // own cache, which its store closes.
  list: readonly Module[] = modules,
) {
  const own = list === modules ? undefined : databasesOf(list);
  const store = perOrganization({
    core: coreMongo,
    registry: organisationRegistry(coreMongo),
    modules: list,
    // `own` is typed for another module list; the store only needs a cache.
    databases: (own ?? databases) as typeof databases,
    membership: (organisationId, accountId) =>
      membership.roleOf(organisationId, accountId),
    // Never `syncAll` or `syncMongoInvitations` on the core database:
    // janus-mongo registers its own `invitations` definition (validator and
    // TTL index) on import, and syncing it here would put it on the app's own
    // `invitations` collection. Sync explicit lists only.
    syncCore: async (core) => {
      await syncMongoAdapter(dbOf(core));
    },
  });
  if (own) {
    const close = store.close.bind(store);
    store.close = async () => {
      await close();
      await own.close();
    };
  }
  return store;
}

// The store as wired (the scripts type their dependencies with it).
export type AppTenancy = ReturnType<typeof tenancyOf>;

// The store of everything that is not a request: scripts, jobs and the specs
// read the organisation databases through it. It admits nobody (no request is
// served through it); the app builds its own with the membership its requests
// ask (src/app.ts). Both stores of the process share the one `databases` cache
// over the one client.
export const tenancy: AppTenancy = tenancyOf({ roleOf: async () => null });

export type OrganisationMongo = Awaited<ReturnType<AppTenancy["databaseOf"]>>;

// An organisation's database as module `Name` sees it: its own collections and
// those of the modules it `dependsOn` (a foreign collection fails typecheck).
export type ModuleMongo<Name extends ModuleName> = ModuleHandle<
  Name,
  OrganisationMongo
>;

// The shutdown: the cached organisation handles, the core's, then the shared
// client (its connection is the last holder).
export async function closeDatabases() {
  await tenancy.close();
  await databases.close();
  await coreMongo.close();
  await connection.close();
}

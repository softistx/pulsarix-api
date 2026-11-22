import { app } from "./app";
import { syncCoreAtBoot } from "./config/core-sync";
import { coreMongo, tenancy } from "./config/db";
import { env } from "./config/env";
import { serverMedia } from "./config/media";
import { migrateAtBoot } from "./config/migrate-at-boot";
import {
  startFilesRetentionWorker,
  startReporterMailWorker,
  startRetentionWorker,
} from "./modules/intake/public";
import { startDigestWorker } from "./modules/notifications/public";

// Janus and core validators/indexes reach production here, before any request.
await syncCoreAtBoot(coreMongo);
// Every organisation database to the data migrations (src/core/migrations).
await migrateAtBoot(tenancy);

await startDigestWorker();
startRetentionWorker(tenancy);
startReporterMailWorker(tenancy);
startFilesRetentionWorker(tenancy, serverMedia);
app.listen({ port: env.PORT });
console.log(`pulsarix-api listening on :${env.PORT}`);

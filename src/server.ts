import { app } from "./app";
import { tenancy } from "./config/db";
import { env } from "./config/env";
import { serverMedia } from "./config/media";
import {
  startFilesRetentionWorker,
  startRetentionWorker,
} from "./modules/intake/public";
import { startDigestWorker } from "./modules/notifications/public";

startDigestWorker();
startRetentionWorker(tenancy);
startFilesRetentionWorker(tenancy, serverMedia);
app.listen({ port: env.PORT });
console.log(`pulsarix-api listening on :${env.PORT}`);

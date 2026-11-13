import { app } from "./app";
import { tenancy } from "./config/db";
import { env } from "./config/env";
import { startRetentionWorker } from "./modules/intake/public";
import { startDigestWorker } from "./modules/notifications/public";

startDigestWorker();
startRetentionWorker(tenancy);
app.listen({ port: env.PORT });
console.log(`pulsarix-api listening on :${env.PORT}`);

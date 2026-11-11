import { app } from "./app";
import { env } from "./config/env";
import { startDigestWorker } from "./modules/notifications/notifications.worker";

startDigestWorker();
app.listen({ port: env.PORT });
console.log(`pulsarix-api listening on :${env.PORT}`);

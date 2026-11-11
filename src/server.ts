import { app } from "./app";
import { env } from "./config/env";

app.listen({ port: env.PORT });
console.log(`pulsarix-api listening on :${env.PORT}`);

import { alxia, health } from "@alxia/core";
import { graphql } from "@alxia/graphql";
import { env } from "./config/env";
import { schema } from "./http/schema";

// GET /health (liveness) and GET /ready (readiness), then POST and GET
// /graphql, the one entry point. /ready has no dependency to check yet: the
// Mongo, Redis and catalogue checks join it with the slice that adds each.
export function createApp() {
  return alxia()
    .decorate({ env })
    .plugin(health({ checks: {} }))
    .plugin((app) => graphql(app, { schema, context: () => ({}) }));
}

export const app = createApp();

export type App = typeof app;

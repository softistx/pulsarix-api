import { health } from "@alxia/core";
import { graphql } from "@alxia/graphql";
import { viewerMemberships } from "@alxia/tenancy";
import { serverAuth } from "./config/auth";
import {
  type AppTenancy,
  closeDatabases,
  coreMongo,
  tenancyOf,
} from "./config/db";
import { serverMedia } from "./config/media";
import { realtime } from "./config/redis";
import { type Access, accessOf, type Membership } from "./core/access";
import type { Auth } from "./core/auth";
import { janusViewer, type Viewer } from "./core/auth/viewer";
import type { OrganisationLimits } from "./core/organisations/organisations.limits";
import { services } from "./core/services";
import { requestScope } from "./core/tenancy";
import { type BaseOptions, createBase } from "./http/context";
import { clientHeader } from "./http/csrf";
import { graphqlPlugins } from "./http/graphql-plugins";
import { schema } from "./http/schema";
import { mediaPipeline } from "./modules/attachments/attachments.routes";
import {
  type Media,
  useMedia,
} from "./modules/attachments/attachments.storage";
import { publicRoutes } from "./modules/intake/intake.routes";
import { serverIntake } from "./modules/intake/intake.server";
import type { PublicIntake } from "./modules/intake/intake.submit";
import { modules } from "./modules/registry";
import { type ChronixLinkFactory, useChronix } from "./modules/time/chronix";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

// The probes (GET /health, GET /ready), then POST and GET /graphql, the one
// entry point, behind the base's middlewares. /graphql refuses a request
// without `x-pulsarix-client` (src/http/csrf.ts), which Apollo Sandbox is
// given. /ready answers 503 while MongoDB does not: the core database answers
// a ping.
//
// `auth` is janus (src/core/auth) on the core database: the viewer is read from
// its sessions (`Authorization: Bearer <janus token>`) unless a spec gives its
// own `resolveViewer`, and a member's role from its relations unless a spec
// gives its own `membership`. `access` is the role -> permission catalogue
// built from the modules' manifests.
//
// `context` builds, per request, the kernel's services and the request's
// `scope`, which resolves the organisation of `x-organization-id` (and the
// viewer's role in it) only when a guard asks (src/core/access/guards.ts), so
// no request pays for it that does not need it.
export function createApp(
  options: BaseOptions & {
    auth?: Auth;
    // The membership reads (janus's by default): the roles the guards ask for.
    // A spec gives its own.
    membership?: Membership;
    // The access catalogue (built from the registry by default); a spec gives
    // the catalogue of a sample module list.
    access?: Access;
    // The tenancy store of the requests (`tenancyOf` over `membership` by
    // default, src/config/db.ts); a spec that needs other collections gives its
    // own. The app closes it with itself.
    tenancy?: AppTenancy;
    // The schema served (the registry's by default).
    schema?: typeof schema;
    // The file store of the attachments (src/config/media.ts by default, none
    // without S3_*); a spec gives its own, or none.
    media?: Media | undefined;
    // The public intake behind /public/graphql (the server's by default: Redis
    // rate limits, the server's mailer); a spec gives its own.
    intake?: PublicIntake;
    // The rate limits of the kernel (Redis's by default, none without Redis);
    // a spec gives its own.
    limits?: OrganisationLimits | undefined;
    // The chronix link client (the HTTP one by default, src/modules/time/chronix.ts);
    // a spec gives a fake.
    chronix?: ChronixLinkFactory;
  } = {},
) {
  const auth = options.auth ?? serverAuth();
  const membership = options.membership ?? auth.membership;
  const access = options.access ?? accessOf(modules);
  const tenancy = options.tenancy ?? tenancyOf(membership);
  const limits = "limits" in options ? options.limits : realtime.limits;
  // Without Redis nothing rate-limits organisation creation: said once.
  if (!limits && Bun.env.NODE_ENV === "production") {
    console.warn(
      "no rate limits (no Redis): organisation creation is not limited",
    );
  }
  const media = "media" in options ? options.media : serverMedia;
  useMedia(media);
  useChronix(options.chronix);
  const intake = options.intake ?? serverIntake(tenancy);
  const pipeline = mediaPipeline({
    media,
    access,
    scopeOf: (request, viewer) => requestScope(tenancy, request, viewer),
  });
  return (
    createBase({
      ...options,
      resolveViewer: options.resolveViewer ?? janusViewer(auth),
    })
      .plugin(probes())
      // A body past 100 KiB is refused (413) before it is read, for /graphql
      // below: a query is a few kilobytes (alxia's production guide, "Cap the body").
      .bodyLimit(BODY_LIMIT)
      // The file routes, beside /graphql (src/modules/attachments): the same
      // CSRF header, Bearer token and `x-organization-id`. Without S3_* they
      // answer 503.
      .group((group) => group.use(pipeline.guard).plugin(pipeline.routes))
      // The widget's endpoint and the tracking page's: the one unauthenticated
      // surface, with a schema, a CORS policy and rate limits of its own.
      .plugin(publicRoutes(intake))
      .plugin((app) =>
        graphql(app, {
          schema: options.schema ?? schema,
          context: graphqlContext({
            auth,
            membership,
            access,
            tenancy,
            limits,
          }),
          plugins: graphqlPlugins,
          ide: "apollo-sandbox",
          sandbox: { initialHeaders: { [clientHeader]: "apollo-sandbox" } },
        }),
      )
      .onStop(async () => {
        await realtime.close();
        await tenancy.close();
        await closeDatabases();
      })
  );
}

// The per-request context: the kernel's services, the access catalogue, the
// viewer's memberships and the request's tenant scope.
type ContextDeps = {
  auth: Auth;
  membership: Membership;
  access: Access;
  tenancy: AppTenancy;
  limits?: OrganisationLimits | undefined;
};

export function graphqlContext({
  auth,
  membership,
  access,
  tenancy,
  limits,
}: ContextDeps) {
  return ({
    request,
    viewer,
  }: {
    request: Request;
    viewer: Viewer | null;
  }) => ({
    services: services({ auth, core: coreMongo, tenancy, request, limits }),
    access,
    memberships: viewerMemberships(
      (organisationId, accountId) =>
        membership.roleOf(organisationId, accountId),
      viewer,
    ),
    scope: requestScope(tenancy, request, viewer),
  });
}

// /health and /ready: Mongo answers a ping within a second.
function probes() {
  return health({
    checks: {
      mongo: async () =>
        Object.values(await coreMongo.ping({ timeoutMS: 1_000 })).every(
          (result) => result.ok,
        ),
    },
  });
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;

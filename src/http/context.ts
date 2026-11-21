import { alxia, defineMiddleware } from "@softistx/alxia";
import type { GraphQLContext } from "@softistx/alxia-graphql";
import type { ViewerMemberships } from "@softistx/alxia-tenancy";
import { StoreFailure } from "@softistx/janus";
import type { AppTenancy } from "../config/db";
import { env } from "../config/env";
import type { Access, Role } from "../core/access";
import {
  anonymous,
  type ResolveViewer,
  type Viewer,
} from "../core/auth/viewer";
import type { Services } from "../core/services";
import { unavailable } from "../core/shared/errors";
import { i18n } from "../i18n";
import { clientIp } from "./client-ip";

export type { Viewer } from "../core/auth/viewer";

// The base: what every resolver reads, decorated or derived here: `env`,
// `viewer`, `requestId`, and `t` and `language`, the request's language.
export function createBase(options: BaseOptions = {}) {
  const { resolveViewer = anonymous } = options;

  // `viewer` is the account the request names (`Authorization: Bearer <janus
  // token>`), or null. A query may be anonymous, so this refuses nothing; a
  // resolver that needs a viewer refuses. A session store that cannot answer is
  // a 503 (`auth.errors.unavailable`), never an anonymous request: that would
  // sign everybody out during the outage.
  const viewerOf = defineMiddleware(async ({ request, reply }, next) => {
    let viewer: Viewer | null;
    try {
      viewer = await resolveViewer(request);
    } catch (error) {
      if (!(error instanceof StoreFailure)) throw error;
      return reply(503, { errors: [unavailable().toJSON()] });
    }
    return next({ viewer });
  });

  // `requestId` names the request in logs and audit trails. alxia exposes none,
  // so the base makes one: always generated here, never read from
  // `X-Request-Id`, which any client could forge. It is echoed as the
  // `X-Request-Id` response header, so a user can quote it.
  const requestIdOf = defineMiddleware(({ set }, next) => {
    const requestId: string = crypto.randomUUID();
    set.headers.set("x-request-id", requestId);
    return next({ requestId });
  });

  // The client address (`ip`) is the connection's, or, behind the proxies of
  // TRUSTED_PROXIES, the one they appended to X-Forwarded-For. When
  // API_PROXY_SECRET is set, only a request that carries it (the UI's server)
  // gets the forwarded address honoured (`clientIp`).
  const base = env.TRUSTED_PROXIES
    ? alxia({
        ip: clientIp({
          trusted: env.TRUSTED_PROXIES,
          secret: env.API_PROXY_SECRET,
        }),
      })
    : alxia();
  return base.decorate({ env }).use(i18n).use(requestIdOf).use(viewerOf);
}

export interface BaseOptions {
  // Who the request is from: src/app.ts wires janus's (janusViewer); without
  // it, anonymous. A spec gives its own.
  resolveViewer?: ResolveViewer;
}

export type Base = ReturnType<typeof createBase>;

// The request's scope as a resolver gets it (@softistx/alxia-tenancy): the `tenant`
// (the organisation), `mongo` (its database as the viewer), `core` (the core
// database) and `member` (the viewer's role there).
export type ScopedRequestScope = Awaited<ReturnType<AppTenancy["scope"]>>;

// A resolver's context: graxia's and the base's, plus what src/app.ts's
// `context` option adds per request: `services` (the kernel's), `access` (the
// role -> permission catalogue the modules' manifests declare), `memberships`
// (the viewer's role in any organisation) and `scope`, the organisation the
// request is about, resolved on first use (src/core/tenancy/scope.ts) and read
// through the guards (src/core/access/guards.ts). The generated `Resolvers`
// takes it (codegen.ts: `contextType`). Read only: module code does not assign
// `viewer` or `requestId`.
export type Context = Readonly<
  GraphQLContext<
    Base,
    {
      services: Services;
      access: Access;
      memberships: ViewerMemberships<Role>;
      scope: () => Promise<ScopedRequestScope>;
    }
  >
>;

import { GraphQLError, graphql } from "graphql";
import { addressKey } from "../../core/shared/address";
import { fail } from "../../core/shared/errors";
import { clientHeader } from "../../http/csrf";
import { localeOfRequest } from "../../i18n/locale";
import {
  originNotAllowed,
  persistedOnly,
  unsupportedMedia,
} from "./intake.errors";
import { answerOf, corsHeaders, secure } from "./intake.http";
import { normaliseOrigin } from "./intake.origins";
import {
  type PersistedId,
  persistedOperations,
  publicSchema,
} from "./intake.public-schema";
import type { Caller, PublicIntake } from "./intake.submit";

// The body /public/graphql reads: a report is at most 10 000 characters of
// description plus a title and 2 KB of metadata.
export const PUBLIC_BODY_LIMIT = 64 * 1024;

const isPersisted = (id: unknown): id is PersistedId =>
  typeof id === "string" && Object.hasOwn(persistedOperations, id);

// POST /public/graphql (and its CORS preflight): the widget's endpoint and the
// tracking page's, the product's only unauthenticated surface (plan §11).
//
// - persisted operations only, named by `id` (src/modules/intake/intake.public-schema.ts);
// - JSON only (a form cannot send it, so no cross-site form reaches a resolver);
// - CORS for the origins some live key allows, and the key's own list is
//   checked on every call; the answer to a foreign origin carries no CORS header;
// - `clientReportStatus` is for the UI server: refused when the request has an
//   `Origin` (a browser) or lacks the client header.
export function publicRoutes(intake: PublicIntake, log = console.warn) {
  const schema = publicSchema();
  return <App extends { all: (...args: never[]) => App }>(app: App): App =>
    (app as unknown as AnyApp).all(
      "/public/graphql",
      { bodyLimit: PUBLIC_BODY_LIMIT },
      async ({ request, reply, ip }: HandlerContext) => {
        const origin = request.headers.get("origin");
        const caller: Caller = {
          ip: addressKey(ip),
          origin,
          userAgent: request.headers.get("user-agent"),
          language: localeOfRequest(),
          originGranted: false,
        };
        const refuse = (
          error: GraphQLError,
          extra: Record<string, string> = {},
        ) => {
          const { body, status } = answerOf(error, log);
          const retry = error.extensions["retryAfter"] as number | undefined;
          return reply(
            status,
            { errors: [body] },
            {
              headers: {
                ...secure,
                ...(retry !== undefined && { "retry-after": String(retry) }),
                ...(caller.originGranted && origin ? corsHeaders(origin) : {}),
                ...extra,
              },
            },
          );
        };
        try {
          if (request.method === "OPTIONS") {
            const known =
              origin !== null &&
              normaliseOrigin(origin) === origin &&
              (await intake.originKnown(origin, caller.ip));
            if (!known || !origin) throw originNotAllowed();
            return reply(204, undefined, {
              headers: {
                ...secure,
                ...corsHeaders(origin),
                "access-control-allow-methods": "POST, OPTIONS",
                "access-control-allow-headers": "content-type, accept-language",
                "access-control-max-age": "600",
              },
            });
          }
          if (request.method !== "POST") {
            return reply(
              405,
              { errors: [] },
              { headers: { ...secure, allow: "POST, OPTIONS" } },
            );
          }
          if (
            !request.headers
              .get("content-type")
              ?.toLowerCase()
              .startsWith("application/json")
          ) {
            throw unsupportedMedia();
          }
          const text = await request.text();
          if (text.length > PUBLIC_BODY_LIMIT) {
            return reply(413, { errors: [] }, { headers: secure });
          }
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            throw persistedOnly();
          }
          const { id, variables, ...rest } = (body ?? {}) as Record<
            string,
            unknown
          >;
          if (
            typeof body !== "object" ||
            body === null ||
            Array.isArray(body) ||
            Object.keys(rest).length > 0 ||
            !isPersisted(id) ||
            (variables !== undefined &&
              (typeof variables !== "object" ||
                variables === null ||
                Array.isArray(variables)))
          ) {
            throw persistedOnly();
          }
          if (id === "clientReportStatus") {
            // For the UI server only: a browser always sends an Origin.
            if (origin !== null) throw originNotAllowed();
            if (!request.headers.get(clientHeader)?.trim()) {
              throw fail("auth.errors.client-header-required", {
                params: { header: clientHeader },
                status: 403,
              });
            }
          }
          const result = await graphql({
            schema,
            source: persistedOperations[id],
            variableValues: (variables ?? {}) as Record<string, unknown>,
            contextValue: { intake, caller },
          });
          const first = result.errors?.[0];
          if (first) return refuse(first);
          return reply(200, result, {
            headers: {
              ...secure,
              ...(caller.originGranted && origin ? corsHeaders(origin) : {}),
            },
          });
        } catch (error) {
          if (error instanceof GraphQLError) return refuse(error);
          // The route's own body limit (alxia) refused it while it was read.
          if ((error as { status?: number }).status === 413) {
            return reply(413, { errors: [] }, { headers: secure });
          }
          log("public intake failed", error);
          return refuse(
            new GraphQLError("Internal error", {
              originalError: error as Error,
            }),
          );
        }
      },
    ) as App;
}

// The slice of alxia's route API this file uses, typed loosely: the handler's
// context is alxia's, whose full type depends on the app's chain.
interface HandlerContext {
  request: Request;
  ip: string | undefined;
  reply: (
    status: number,
    body?: unknown,
    init?: { headers?: Record<string, string> },
  ) => never;
}
interface AnyApp {
  all: (
    path: string,
    options: { bodyLimit: number },
    handler: (ctx: HandlerContext) => unknown,
  ) => unknown;
}

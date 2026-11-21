import { alxia } from "@softistx/alxia";
import { GraphQLError, graphql } from "graphql";
import { addressKey } from "../../../core/shared/address";
import { fail } from "../../../core/shared/errors";
import { clientHeader } from "../../../http/csrf";
import { localeOfRequest } from "../../../i18n/locale";
import {
  type PersistedId,
  persistedOperations,
  publicSchema,
  trackingOperations,
} from "../graphql/public.schema";
import {
  originNotAllowed,
  persistedOnly,
  unsupportedMedia,
} from "../intake.errors";
import {
  answerOf,
  corsHeaders,
  respond,
  secure,
  TRACKING_HEADER,
} from "../intake.http";
import { IDENTITY_HEADER } from "../services/identity.service";
import { normaliseOrigin } from "../rules/origins.rules";
import type { Caller, PublicIntake } from "../services/submit.service";

// The body /public/graphql reads: a report is at most 10 000 characters of
// description plus a title and 2 KB of metadata.
export const PUBLIC_BODY_LIMIT = 64 * 1024;

const isPersisted = (id: unknown): id is PersistedId =>
  typeof id === "string" && Object.hasOwn(persistedOperations, id);

// POST /public/graphql (and its CORS preflight): the widget's endpoint and the
// tracking page's, the product's only unauthenticated surface (plan §11).
//
// - persisted operations only, named by `id` (src/modules/intake/graphql/public.schema.ts);
// - JSON only (a form cannot send it, so no cross-site form reaches a resolver);
// - CORS for the origins some live key allows, and the key's own list is
//   checked on every call; the answer to a foreign origin carries no CORS header;
// - the tracking page's operations (`clientReportStatus`, `tracking*`) are for the UI server: refused when the request has an
//   `Origin` (a browser) or lacks the client header.
export function publicRoutes(intake: PublicIntake, log = console.warn) {
  const schema = publicSchema();
  return alxia().all(
    "/public/graphql",
    { bodyLimit: PUBLIC_BODY_LIMIT },
    async ({ request, ip }) => {
      const origin = request.headers.get("origin");
      const caller = callerOf(request, ip);
      const refuse = (error: GraphQLError) => refusal(error, caller, log);
      try {
        if (request.method === "OPTIONS") {
          return await preflight(intake, origin, caller.ip);
        }
        if (request.method !== "POST") {
          return respond(
            405,
            { errors: [] },
            { headers: { ...secure, allow: "POST, OPTIONS" } },
          );
        }
        const { id, variables } = await persistedCall(request);
        if (trackingOperations.has(id)) guardTracking(request, origin);
        const result = await graphql({
          schema,
          source: persistedOperations[id],
          variableValues: variables,
          contextValue: { intake, caller },
        });
        const first = result.errors?.[0];
        if (first) return refuse(first);
        return respond(200, result, {
          headers: {
            ...secure,
            ...(caller.originGranted && origin ? corsHeaders(origin) : {}),
          },
        });
      } catch (error) {
        if (error instanceof GraphQLError) return refuse(error);
        // The route's own body limit (alxia) refused it while it was read.
        if ((error as { status?: number }).status === 413) {
          return respond(413, { errors: [] }, { headers: secure });
        }
        log("public intake failed", error);
        return refuse(
          new GraphQLError("Internal error", {
            originalError: error as Error,
          }),
        );
      }
    },
  );
}

const callerOf = (request: Request, ip: string | undefined): Caller => ({
  ip: addressKey(ip),
  origin: request.headers.get("origin"),
  userAgent: request.headers.get("user-agent"),
  identity: request.headers.get(IDENTITY_HEADER),
  tracking: request.headers.get(TRACKING_HEADER),
  language: localeOfRequest(),
  originGranted: false,
});

// A refusal as the endpoint answers it: the error's status and body, the wait
// of a 429, the CORS headers once the key's origin check has passed.
function refusal(
  error: GraphQLError,
  caller: Caller,
  log: typeof console.warn,
) {
  const { body, status } = answerOf(error, log);
  const retry = error.extensions["retryAfter"] as number | undefined;
  return respond(
    status,
    { errors: [body] },
    {
      headers: {
        ...secure,
        ...(retry !== undefined && { "retry-after": String(retry) }),
        ...(caller.originGranted && caller.origin
          ? corsHeaders(caller.origin)
          : {}),
      },
    },
  );
}

// The answer to the CORS preflight: the origins some live key allows only.
async function preflight(
  intake: PublicIntake,
  origin: string | null,
  ip: string,
) {
  const known =
    origin !== null &&
    normaliseOrigin(origin) === origin &&
    (await intake.originKnown(origin, ip));
  if (!known || !origin) throw originNotAllowed();
  return respond(204, undefined, {
    headers: {
      ...secure,
      ...corsHeaders(origin),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, accept-language, x-pulsarix-identity",
      "access-control-max-age": "600",
    },
  });
}

// The call a POST carries: JSON only, `{ id, variables }` and nothing else,
// the id one of the persisted operations. Anything else is `persistedOnly`.
async function persistedCall(
  request: Request,
): Promise<{ id: PersistedId; variables: Record<string, unknown> }> {
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
    // Answered 413 by the route's catch, as the body limit's own refusal is.
    throw Object.assign(new Error("body too large"), { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw persistedOnly();
  }
  const { id, variables, ...rest } = (body ?? {}) as Record<string, unknown>;
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
  return { id, variables: (variables ?? {}) as Record<string, unknown> };
}

// The tracking page's operations are for the UI server: a browser always
// sends an Origin, and the client header must be there.
function guardTracking(request: Request, origin: string | null) {
  if (origin !== null) throw originNotAllowed();
  if (!request.headers.get(clientHeader)?.trim()) {
    throw fail("auth.errors.client-header-required", {
      params: { header: clientHeader },
      status: 403,
    });
  }
}

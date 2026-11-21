import { GraphQLError } from "graphql";
import { addressKey } from "../../../core/shared/address";
import { localeOfRequest } from "../../../i18n/locale";
import { originNotAllowed } from "../intake.errors";
import { answerOf, corsHeaders, respond, secure } from "../intake.http";
import { normaliseOrigin } from "../rules/origins.rules";
import { IDENTITY_HEADER } from "../services/identity.service";
import type { Caller, PublicIntake } from "../services/submit.service";

// What the identified reporter's two GET routes share (plan §19, A17): the
// caller, the key of the query, the CORS preflight and the refusal. Both are
// read with `fetch`: the identity token is the `x-pulsarix-identity` header
// (never the URL, which logs keep) and the public key is the `key` query
// parameter. CORS is the key's: only an origin its list allows is answered
// with the CORS header.

export const callerOf = (request: Request, ip: string | undefined): Caller => ({
  ip: addressKey(ip),
  origin: request.headers.get("origin"),
  userAgent: request.headers.get("user-agent"),
  identity: request.headers.get(IDENTITY_HEADER),
  language: localeOfRequest(),
  originGranted: false,
});

export const keyOf = (request: Request) =>
  new URL(request.url).searchParams.get("key") ?? "";

export async function preflight(
  intake: PublicIntake,
  request: Request,
  ip: string | undefined,
) {
  const origin = request.headers.get("origin");
  const known =
    origin !== null &&
    normaliseOrigin(origin) === origin &&
    (await intake.originKnown(origin, addressKey(ip)));
  if (!known || !origin) throw originNotAllowed();
  return respond(204, undefined, {
    headers: {
      ...secure,
      ...corsHeaders(origin),
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "accept-language, x-pulsarix-identity",
      "access-control-max-age": "600",
    },
  });
}

export function refusal(
  caught: unknown,
  caller: Caller,
  log: typeof console.warn,
) {
  let error: GraphQLError;
  if (caught instanceof GraphQLError) error = caught;
  else {
    log("public request read failed", caught);
    error = new GraphQLError("Internal error", {
      originalError: caught as Error,
    });
  }
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

import { GraphQLError } from "graphql";
import { fail } from "../../core/shared/errors";
import { clientHeader } from "../../http/csrf";
import { originNotAllowed } from "./intake.errors";
import { answerOf, corsHeaders, respond, secure } from "./intake.http";
import { normaliseOrigin } from "./intake.origins";
import type { PublicIntake } from "./intake.submit";
import { TICKET_HEADER } from "./intake.tickets";

// What the upload route answers when it refuses: the failure of a PUT, the
// CORS preflight, the client-header check.

// What a failed PUT answers: a GraphQL error as its refusal (counted against
// the key), a body past the limit 413, anything else a logged 500.
export function failure(
  error: unknown,
  {
    count,
    cors,
    log,
  }: {
    count: (error: unknown) => void;
    cors: Record<string, string>;
    log: (message: string, error?: unknown) => void;
  },
) {
  if (error instanceof GraphQLError) {
    count(error);
    return refusal(error, cors, log);
  }
  if ((error as { status?: number }).status === 413) {
    return respond(413, { errors: [] }, { headers: secure });
  }
  log("report file upload failed", error);
  return refusal(
    new GraphQLError("Internal error", { originalError: error as Error }),
    cors,
    log,
  );
}

// A tracking page's upload comes from the UI server, which sends the client
// header (a browser's cross-site form does not).
export function requireClientHeader(request: Request) {
  if (!request.headers.get(clientHeader)?.trim()) {
    throw fail("auth.errors.client-header-required", {
      params: { header: clientHeader },
      status: 403,
    });
  }
}

// The answer to the CORS preflight: the key's origins only, 403 otherwise.
export async function preflight(
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
      "access-control-allow-methods": "PUT, OPTIONS",
      "access-control-allow-headers": `content-type, ${TICKET_HEADER}`,
      "access-control-max-age": "600",
    },
  });
}

// A refusal as the endpoint answers it: the error's status and body, the wait
// of a 429, the CORS headers once the key's origin check has passed.
export function refusal(
  error: GraphQLError,
  cors: Record<string, string>,
  log: (message: string, error: unknown) => void,
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
        ...cors,
      },
    },
  );
}

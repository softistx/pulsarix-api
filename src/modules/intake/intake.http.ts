import { GraphQLError } from "graphql";

// Every answer: nothing is cached, sniffed, indexed or leaked through a
// referrer (the tracking token travels in the page's path, not here, but the
// answers hold reports).
export const secure = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
} as const;

export const corsHeaders = (origin: string) => ({
  "access-control-allow-origin": origin,
  vary: "Origin",
});

export type Status =
  | 200
  | 204
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 410
  | 413
  | 415
  | 429
  | 500
  | 503;
const statuses: readonly number[] = [
  400, 401, 403, 404, 405, 409, 410, 413, 415, 429, 500, 503,
];
export const asStatus = (value: unknown): Status =>
  typeof value === "number" && statuses.includes(value)
    ? (value as Status)
    : 400;

// A GraphQL error as the endpoint answers it: ours (a coded refusal) and the
// validation of a document's variables as they are; anything else (a bug, a
// database failure) is masked, its detail kept in the log.
export function answerOf(
  error: GraphQLError,
  log: (message: string, error: unknown) => void,
): { body: unknown; status: Status } {
  const original = error.originalError;
  if (original && !(original instanceof GraphQLError)) {
    log("public intake failed", original);
    return {
      body: {
        message: "Internal error",
        extensions: { code: "internal-error", http: { status: 500 } },
      },
      status: 500,
    };
  }
  return {
    body: error.toJSON(),
    status: asStatus(
      (error.extensions["http"] as { status?: number } | undefined)?.status,
    ),
  };
}

// The tracking page's thumbnail route and the header its token travels in
// (intake.tracking.routes.ts); the token stays out of the URL, which logs keep.
export const TRACKING_HEADER = "x-pulsarix-tracking";
export const TRACKING_FILES_PATH = "/public/tracking/files";

// A JSON answer, built as a plain `Response` (what an alxia `all` route ends
// with): no body for `undefined`, the content type for anything else.
export function respond(
  status: number,
  body?: unknown,
  init: { headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = { ...init.headers };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

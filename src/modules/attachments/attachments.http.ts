import type { MediaBucket } from "@softistx/alxia-media";
import { StoreFailure } from "@softistx/janus";
import { isBucketUnavailable } from "@softistx/s3";
import { GraphQLError } from "graphql";
import type { Access } from "../../core/access";
import { unavailable as sessionsUnavailable } from "../../core/shared/errors";
import type { ScopedRequestScope, Viewer } from "../../http/context";
import { unavailable } from "./attachments.errors";
import type { Media } from "./attachments.store";

export interface MediaDeps {
  // The file store, or none when S3 is not configured (503).
  media: Media | undefined;
  // The role -> permission catalogue the guards read.
  access: Access;
  // The request's tenant scope, as /graphql's context builds it: resolved on
  // first use.
  scopeOf: (
    request: Request,
    viewer: Viewer | null,
  ) => () => Promise<ScopedRequestScope>;
}

const refusalStatuses = [400, 401, 403, 404, 409, 413, 415, 422, 503] as const;
type RefusalStatus = (typeof refusalStatuses)[number];
const isRefusalStatus = (status: unknown): status is RefusalStatus =>
  refusalStatuses.includes(status as RefusalStatus);

// A refusal as the JSON the GraphQL errors have, so a client reads a REST
// refusal and a GraphQL one alike. Null for an error that is not a refusal of
// the app (it reaches the route boundary).
export function refusalBody(
  error: unknown,
): { status: RefusalStatus; body: { errors: unknown[] } } | null {
  if (error instanceof GraphQLError) {
    const status = (error.extensions["http"] as { status?: number } | undefined)
      ?.status;
    return isRefusalStatus(status)
      ? { status, body: { errors: [error.toJSON()] } }
      : null;
  }
  // janus's store could not answer: 503, as for /graphql.
  if (error instanceof StoreFailure) return refusalBody(sessionsUnavailable());
  // The bucket cannot be used (no answer in time, a refused connection or
  // credential, no such bucket): later, not 500.
  if (isBucketUnavailable(error)) return refusalBody(unavailable());
  return null;
}

const dead = () => {
  throw unavailable();
};
// What the routes are built over when S3 is not configured: the guard refuses
// every request with a 503 before a route could touch it.
export const noBucket: MediaBucket = { open: dead, put: dead, delete: dead };

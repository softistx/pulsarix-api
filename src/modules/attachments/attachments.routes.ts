import { defineMiddleware } from "@softistx/alxia";
import {
  type MediaBucket,
  mediaRoutes as routesOf,
} from "@softistx/alxia-media";
import { StoreFailure } from "@softistx/janus";
import { isBucketUnavailable } from "@softistx/s3";
import { GraphQLError } from "graphql";
import { type Access, can, requirePermission } from "../../core/access";
import {
  fail,
  unavailable as sessionsUnavailable,
} from "../../core/shared/errors";
import type { ScopedRequestScope, Viewer } from "../../http/context";
import { clientHeader } from "../../http/csrf";
import { commentNotYours } from "../comments/public";
import { refusalFailure, unavailable } from "./attachments.errors";
import {
  attachmentKind,
  kindName,
  type MediaAccess,
  maxBytes,
  maxPixels,
  previewSize,
} from "./attachments.kinds";
import {
  type AttachmentsMongo,
  AttachmentsService,
  cleanFileName,
  resolveOwner,
} from "./attachments.service";
import { folderOf, type Media } from "./attachments.storage";

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
const noBucket: MediaBucket = { open: dead, put: dead, delete: dead };

// The /media group of `createApp`, in this order:
//
// 1. 403 `auth.errors.client-header-required`: no `x-pulsarix-client`, as for
//    /graphql, so no cross-site form or <img> reaches a route;
// 2. 401 `auth.errors.unauthenticated`: no janus Bearer token;
// 3. 503 `attachments.errors.unavailable`: S3 is not configured;
// 4. the organisation (`x-organization-id`) and the permission:
//    `attachment:write` for a PUT, `attachment:read` for a read. A PUT also
//    names its owner (`ownerType`, `ownerId`) and `fileName` in the query: the
//    owner must exist, a comment's files are added by its author (or an
//    admin), and an owner carries at most `maxPerOwner` files;
//
// then @softistx/alxia-media's routes: PUT /media/attachments and GET
// /media/attachments/:key[/256], with the content types, the size limit and the
// thumbnail of attachments.kinds.ts. The record is made as the upload
// answers, so a stored file always has one; a read is served only while a
// record carries the key, in the caller's organisation.
export function mediaPipeline(deps: MediaDeps) {
  const guard = defineMiddleware<{ viewer: Viewer | null }>()(
    async ({ request, viewer, reply }, next) => {
      try {
        if (!request.headers.get(clientHeader)?.trim()) {
          throw fail("auth.errors.client-header-required", {
            params: { header: clientHeader },
            status: 403,
          });
        }
        if (!viewer) throw fail("auth.errors.unauthenticated", { status: 401 });
        if (!deps.media) throw unavailable();
        const call = {
          request,
          viewer,
          access: deps.access,
          scope: deps.scopeOf(request, viewer),
        };
        const writing = request.method === "PUT";
        const scope = await requirePermission(
          call,
          writing ? "attachment:write" : "attachment:read",
        );
        const media: MediaAccess["media"] = { scope, viewerId: viewer.id };
        if (writing) {
          const query = new URL(request.url).searchParams;
          const mongo = scope.mongo as unknown as AttachmentsMongo;
          const owner = await resolveOwner(
            mongo,
            query.get("ownerType"),
            query.get("ownerId"),
          );
          const fileName = cleanFileName(query.get("fileName"));
          if (!fileName) {
            throw fail("validation.errors.invalid-input", {
              status: 400,
            });
          }
          if (
            owner.ownerType === "comment" &&
            owner.authorId !== viewer.id &&
            !(await can(call, "comment:delete"))
          ) {
            throw commentNotYours();
          }
          await new AttachmentsService(
            mongo,
            viewer.id,
            false,
            scope.tenant._id.toHexString(),
          ).ensureRoom(owner);
          media.upload = { ...owner, fileName };
        }
        return await next({ media });
      } catch (error) {
        const refusal = refusalBody(error);
        if (!refusal) throw error;
        return reply(refusal.status, refusal.body);
      }
    },
  );
  const routes = routesOf([attachmentKind], {
    bucket: deps.media?.bucket ?? noBucket,
    prefix: "/media",
    // One folder per organisation: a file never leaves it.
    keyPrefix: ({ media }) => folderOf(media.scope.tenant._id.toHexString()),
    // The record is made here: if it fails, the stored file is removed.
    uploaded: async ({ key, contentType, size, sizes }, { media }) => {
      const upload = media.upload;
      if (!upload) throw unavailable();
      const mongo = media.scope.mongo as unknown as AttachmentsMongo;
      const created = await new AttachmentsService(
        mongo,
        media.viewerId,
        false,
        media.scope.tenant._id.toHexString(),
      ).record({
        owner: upload,
        fileName: upload.fileName,
        mime: contentType,
        size,
        storageKey: key,
        previewKey: sizes.includes(previewSize) ? previewSize : null,
      });
      return { id: created.id, key, size, previewKey: created.previewKey };
    },
    refusal: (refusal, { reply }) => {
      // A refusal the app has a code for is answered in its shape; the others
      // (`stalled`, `interrupted`...) keep the package's body.
      const failure = refusalFailure(refusal, { maxBytes, maxPixels });
      const answer = failure ? refusalBody(failure) : null;
      return answer ? reply(answer.status, answer.body) : undefined;
    },
  });
  return { guard, routes, kindName };
}

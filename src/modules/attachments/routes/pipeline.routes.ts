import type { MediaDeps } from "../attachments.http";
import { kindName } from "../attachments.kinds";
import { fileRoutes } from "./files.routes";
import { mediaGuard } from "./guard.routes";

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
  return { guard: mediaGuard(deps), routes: fileRoutes(deps), kindName };
}

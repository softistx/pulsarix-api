import { defineMiddleware } from "@softistx/alxia";
import { can, requirePermission } from "../../../core/access";
import { fail, invalid } from "../../../core/shared/errors";
import type { Viewer } from "../../../http/context";
import { clientHeader } from "../../../http/csrf";
import { commentNotYours } from "../../comments/public";
import { unavailable } from "../attachments.errors";
import { type MediaDeps, refusalBody } from "../attachments.http";
import type { MediaAccess } from "../attachments.kinds";
import {
  type AttachmentsMongo,
  AttachmentsService,
  resolveOwner,
} from "../attachments.service";
import { cleanFileName } from "../attachments.utils";

type Call = Parameters<typeof can>[0];

// What a PUT names in its query, checked: the owner must exist, a comment's
// files are added by its author (or a moderator), and an owner carries at
// most `maxPerOwner` files.
async function uploadOf(
  request: Request,
  call: Call,
  scope: MediaAccess["media"]["scope"],
  viewer: Viewer,
) {
  const query = new URL(request.url).searchParams;
  const mongo = scope.mongo as unknown as AttachmentsMongo;
  const owner = await resolveOwner(
    mongo,
    query.get("ownerType"),
    query.get("ownerId"),
  );
  const fileName = cleanFileName(query.get("fileName"));
  if (!fileName) {
    throw invalid([{ path: "fileName", code: "validation.errors.invalid" }]);
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
  return { ...owner, fileName };
}

// The checks before a route runs, in the order `mediaPipeline` lists.
export function mediaGuard(deps: MediaDeps) {
  return defineMiddleware<{ viewer: Viewer | null }>()(
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
        if (writing)
          media.upload = await uploadOf(request, call, scope, viewer);
        return await next({ media });
      } catch (error) {
        const refusal = refusalBody(error);
        if (!refusal) throw error;
        return reply(refusal.status, refusal.body);
      }
    },
  );
}

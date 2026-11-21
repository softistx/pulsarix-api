import { mediaRoutes as routesOf } from "@softistx/alxia-media";
import { refusalFailure, unavailable } from "../attachments.errors";
import { type MediaDeps, noBucket, refusalBody } from "../attachments.http";
import {
  attachmentKind,
  maxBytes,
  maxPixels,
  previewSize,
} from "../attachments.kinds";
import {
  type AttachmentsMongo,
  AttachmentsService,
} from "../attachments.service";
import { folderOf } from "../attachments.store";

// The routes of @softistx/alxia-media over the one bucket: the record is made
// as the upload answers, so a stored file always has one.
export function fileRoutes(deps: MediaDeps) {
  return routesOf([attachmentKind], {
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
}

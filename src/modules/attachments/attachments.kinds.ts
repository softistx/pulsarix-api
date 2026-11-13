import { defineMediaKind } from "@alxia/media";
import { withImageRendition } from "@alxia/media/image";
import { ImageError } from "@softistx/image";
import { renderPdfFirstPage } from "@softistx/image/pdf";
import type { ScopedRequestScope } from "../../http/context";
import type { OwnerType } from "./attachments.model";

// What an upload may be, spelt out because the refusals name it.
export const maxBytes = 10 * 1024 * 1024;
export const maxPixels = 25_000_000;
// Files on one issue, and on one comment.
export const maxPerOwner = 20;
// JPEG, PNG and WebP pictures (with a thumbnail) and PDF files.
export const acceptedTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export const kindName = "attachments";
// The side of the square thumbnail an image gets, and its name in the URL.
export const thumbnailSide = 256;
export const previewSize = String(thumbnailSide);

// What the guard of attachments.routes.ts adds to the context of a /media
// request, after the CSRF header, the Bearer token and the permission: the
// organisation's scope, and for an upload the owner it names.
export interface MediaAccess {
  media: {
    scope: ScopedRequestScope;
    viewerId: string;
    upload?: {
      ownerType: OwnerType;
      ownerId: string;
      issueId: string;
      fileName: string;
    };
  };
}

const images = withImageRendition({
  sizes: [thumbnailSide],
  format: "webp",
  keyExtension: true,
  minSide: 16,
  maxPixels,
});

export const attachmentKind = defineMediaKind<MediaAccess>({
  name: kindName,
  accept: acceptedTypes,
  maxBytes,
  // The guard has already asked for `attachment:write` (and checked the owner
  // and the count) or `attachment:read`, and refused with the app's errors.
  authorizeWrite: () => true,
  // Served only while a record carries the key, to the members the guard let in
  // (`attachment:read`): a key nobody attached, or of another organisation
  // (its folder is the tenant's), is a 404.
  authorizeRead: async ({ media }, key) =>
    (await media.scope.mongo.db.attachments.exists({ storageKey: key })) ===
    true,
  sizes: images.sizes,
  renditions: {
    ...images.renditions,
    // Pictures get the square thumbnail; a PDF gets its first page, fitted in
    // the same square. A PDF that cannot be drawn (damaged, encrypted) is
    // still stored, with no preview.
    make: async (file) => {
      if (file.contentType !== "application/pdf") {
        return images.renditions.make(file);
      }
      try {
        const page = await renderPdfFirstPage(file.bytes, {
          width: thumbnailSide,
          height: thumbnailSide,
          format: "webp",
          maxBytes,
          maxPixels,
        });
        return [
          {
            size: previewSize,
            contentType: page.contentType,
            bytes: page.bytes,
          },
        ];
      } catch (error) {
        if (error instanceof ImageError && error.code === "UNDECODABLE") {
          return [];
        }
        throw error;
      }
    },
  },
});

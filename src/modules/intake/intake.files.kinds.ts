import {
  defineMediaKind,
  type MediaContext,
  type MediaFile,
  type MediaRendition,
  type MediaVerdict,
} from "@alxia/media";
import { withImageRendition } from "@alxia/media/image";
import { ImageError } from "@softistx/image";
import { renderPdfFirstPage } from "@softistx/image/pdf";
import {
  fileTooLarge,
  fileTooManyPixels,
  fileUndecodable,
  fileUnsupportedType,
} from "./intake.errors";

// What a reader may attach to a report (plan §17, A11): PNG, JPEG, WebP and
// PDF, exactly. SVG (it runs script), GIF and HEIC are refused, and `sniff`
// checks the first bytes against the declared type, so a PDF that is an HTML
// page is a 415.
export const fileKindName = "report-files";
export const acceptedFileTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;
export const maxFileBytes = 5 * 1024 * 1024;
// A picture claiming more pixels is refused (422); decoding is bounded by it.
export const maxFilePixels = 25_000_000;
// The longest side of the stored picture (`full`), and the side of the square
// thumbnail (`256`).
export const fullSide = 2560;
export const thumbnailSide = 256;
export const previewSize = String(thumbnailSide);
// The name a PDF's own bytes go by in this API's URLs (`/file`). @alxia/media
// stores them as the kind's original (`<kind>/<key>`, no size): the readers map
// this name to it.
export const pdfSize = "file";

const images = withImageRendition({
  sizes: [thumbnailSide],
  full: { fit: "inside", maxSide: fullSide },
  format: "webp",
  // A small picture is never scaled up; one under 16 px is refused.
  enlarge: false,
  fit: "inside",
  minSide: 16,
  maxPixels: maxFilePixels,
});

// A picture becomes its `full` and `256` renditions (keepOriginal is false: the
// upload, EXIF and GPS data included, is never stored). A PDF is kept as it is
// (`keepOriginal`), beside the `256` preview of its first page made here; a PDF
// that cannot be drawn (damaged, encrypted) is stored with no preview.
const make = async (file: MediaFile): Promise<readonly MediaRendition[]> => {
  if (file.contentType !== "application/pdf") {
    return images.renditions.make(file);
  }
  try {
    const page = await renderPdfFirstPage(file.bytes, {
      width: thumbnailSide,
      height: thumbnailSide,
      format: "webp",
      maxBytes: maxFileBytes,
      maxPixels: maxFilePixels,
    });
    return [
      { size: previewSize, contentType: page.contentType, bytes: page.bytes },
    ];
  } catch (error) {
    if (error instanceof ImageError && error.code === "UNDECODABLE") {
      return [];
    }
    throw error;
  }
};

// Who may write and read is the app's, per route (A12 writes with a signed
// ticket, A13 reads through the BFF): the kind takes both verdicts.
export interface ReportFilesAccess<Requires extends object> {
  authorizeWrite: (
    ctx: MediaContext<Requires>,
  ) => MediaVerdict | Promise<MediaVerdict>;
  authorizeRead: (
    ctx: MediaContext<Requires>,
    key: string,
  ) => MediaVerdict | Promise<MediaVerdict>;
}

export const defineReportFilesKind = <Requires extends object>(
  access: ReportFilesAccess<Requires>,
) =>
  defineMediaKind<Requires>({
    name: fileKindName,
    accept: acceptedFileTypes,
    maxBytes: maxFileBytes,
    sniff: true,
    // Only the PDF's own bytes are stored; a picture is made into its sizes
    // and dropped, so its EXIF and GPS data never reach the bucket. `make` runs
    // on the pictures and on the PDF (for its preview).
    keepOriginal: ["application/pdf"],
    renditionTypes: acceptedFileTypes,
    // A stored object is never an HTML or SVG document: nothing but the four
    // types above is accepted, and every file is served with `nosniff` and
    // `sandbox` (@alxia/media). A PDF is always a download.
    attachment: ["application/pdf"],
    authorizeWrite: access.authorizeWrite,
    authorizeRead: access.authorizeRead,
    sizes: images.sizes,
    renditions: {
      types: [...images.renditions.types, "application/pdf"],
      make,
    },
  });

// What a refusal of @alxia/media is, as the API's error (415, 422, 413). The
// package's transport refusals (`stalled`, `interrupted`...) are left to it.
export function fileRefusal(code: string, reason?: string) {
  switch (code) {
    case "unsupported_type":
      return fileUnsupportedType();
    case "too_large":
      return fileTooLarge(maxFileBytes);
    case "empty_body":
      return fileUndecodable();
    case "unprocessable":
      return reason === "pixels"
        ? fileTooManyPixels(maxFilePixels)
        : fileUndecodable();
    default:
      return undefined;
  }
}

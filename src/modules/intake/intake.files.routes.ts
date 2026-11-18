import {
  type MediaContext,
  type MediaUploaded,
  mediaRoutes,
} from "@alxia/media";
import type { GraphQLError } from "graphql";
import type { Media } from "../attachments/public";
import {
  defineReportFilesKind,
  fileKindName,
  fileRefusal,
  type ReportFilesAccess,
} from "./intake.files.kinds";
import { organisationFolder } from "./intake.files.storage";

export interface ReportFilesRoutesOptions<Requires extends object>
  extends ReportFilesAccess<Requires> {
  media: Media;
  // The organisation whose folder the request's objects go to: resolved by the
  // route's own guard (a ticket, A12), never by the client's say-so.
  organisationOf: (ctx: MediaContext<Requires>) => string;
  // The record is made here, once the renditions are stored; if it throws, the
  // objects are removed.
  uploaded: (
    stored: MediaUploaded,
    ctx: MediaContext<Requires>,
  ) => unknown | Promise<unknown>;
  // The URL prefix of the PUT and GET routes.
  prefix?: `/${string}`;
}

// The `report-files` routes of @alxia/media: PUT and GET under
// `<prefix>/report-files`, objects under `organisations/<id>/report-files/`,
// every refusal of the kind answered as the API's JSON error (415 type or
// bytes, 413 size, 422 unreadable or over 25 megapixels, 503 no store).
export function reportFilesRoutes<Requires extends object>(
  options: ReportFilesRoutesOptions<Requires>,
) {
  const kind = defineReportFilesKind<Requires>(options);
  return mediaRoutes([kind], {
    bucket: options.media.bucket,
    prefix: options.prefix ?? "/media",
    keyPrefix: (ctx) =>
      organisationFolder(options.organisationOf(ctx as MediaContext<Requires>)),
    uploaded: (stored, ctx) =>
      options.uploaded(stored, ctx as MediaContext<Requires>),
    refusal: (refusal, { reply }) => {
      const failure =
        refusal.code === "unavailable"
          ? undefined
          : fileRefusal(refusal.code, refusal.details.reason);
      if (!failure) return undefined;
      const status =
        (failure.extensions["http"] as { status?: number } | undefined)
          ?.status ?? 422;
      return reply(status as 413 | 415 | 422, {
        errors: [(failure as GraphQLError).toJSON()],
      });
    },
  });
}

export { fileKindName };

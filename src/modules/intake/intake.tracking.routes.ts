import { alxia } from "@softistx/alxia";
import { GraphQLError } from "graphql";
import { addressKey } from "../../core/shared/address";
import { fail } from "../../core/shared/errors";
import { clientHeader } from "../../http/csrf";
import { localeOfRequest } from "../../i18n/locale";
import type { Media } from "../attachments/public";
import { fileNotFound, originNotAllowed, unavailable } from "./intake.errors";
import { previewSize } from "./intake.files.kinds";
import { reportFileReader } from "./intake.files.read";
import {
  answerOf,
  respond,
  secure,
  TRACKING_FILES_PATH,
  TRACKING_HEADER,
} from "./intake.http";
import type { PublicIntake } from "./intake.submit";

// GET /public/tracking/files/<fileId>: the thumbnail of one of the reporter's
// own pictures, for the tracking page (`clientReportStatus` lists them). For
// the UI server only, like the status read: refused when the request has an
// `Origin` or lacks the client header. The tracking token is the
// `x-pulsarix-tracking` header (never the URL, which logs keep). It reads the
// 256 px rendition and nothing else: never the picture's `full`, never a PDF,
// and never a file of another report; the same 404 answers them all.
export function trackingFileRoutes(
  intake: PublicIntake,
  media: Media | undefined,
  log = console.warn,
) {
  const read = media ? reportFileReader(media) : undefined;
  return alxia().all(
    `${TRACKING_FILES_PATH}/:id`,
    async ({ request, ip, params }) => {
      try {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return respond(
            405,
            { errors: [] },
            { headers: { ...secure, allow: "GET, HEAD" } },
          );
        }
        if (request.headers.get("origin") !== null) throw originNotAllowed();
        if (!request.headers.get(clientHeader)?.trim()) {
          throw fail("auth.errors.client-header-required", {
            params: { header: clientHeader },
            status: 403,
          });
        }
        if (!read) throw unavailable();
        const token = request.headers.get(TRACKING_HEADER);
        if (!token) throw fileNotFound();
        localeOfRequest();
        const found = await intake.thumbnailOf(
          token,
          params["id"] ?? "",
          addressKey(ip),
        );
        const answer = await read(request, {
          organisationId: found.organisationId,
          key: found.storageKey,
          size: previewSize,
        });
        for (const [name, value] of Object.entries(secure)) {
          answer.headers.set(name, value);
        }
        return answer;
      } catch (caught) {
        let error: GraphQLError;
        if (caught instanceof GraphQLError) {
          error = caught;
        } else {
          log("tracking file read failed", caught);
          error = new GraphQLError("Internal error", {
            originalError: caught as Error,
          });
        }
        const { body, status } = answerOf(error, log);
        const retry = error.extensions["retryAfter"] as number | undefined;
        return respond(
          status,
          { errors: [body] },
          {
            headers: {
              ...secure,
              ...(retry !== undefined && { "retry-after": String(retry) }),
            },
          },
        );
      }
    },
  );
}

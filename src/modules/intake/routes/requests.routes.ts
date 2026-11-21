import { alxia } from "@softistx/alxia";
import type { Media } from "../../attachments/public";
import { unavailable } from "../intake.errors";
import { previewSize } from "../intake.files.kinds";
import { reportFileReader } from "../intake.files.read";
import {
  corsHeaders,
  REQUEST_FILES_PATH,
  respond,
  secure,
} from "../intake.http";
import { thumbnailOf } from "../services/requests-actions.service";
import { callerOf, keyOf, preflight, refusal } from "./requests.http";
import { openSession } from "../services/requests-session.service";
import type { PublicIntake } from "../services/submit.service";

// GET /public/requests/files/<fileId>?key=...: the 256 px thumbnail of one of
// the reporter's own pictures, for the widget's thread. A file of another
// reporter, a PDF, a missing id: the same 404.
export function requestFileRoutes(
  intake: PublicIntake,
  media: Media | undefined,
  log = console.warn,
) {
  const read = media ? reportFileReader(media) : undefined;
  return alxia().all(
    `${REQUEST_FILES_PATH}/:id`,
    async ({ request, ip, params }) => {
      const caller = callerOf(request, ip);
      try {
        if (request.method === "OPTIONS")
          return await preflight(intake, request, ip);
        if (request.method !== "GET" && request.method !== "HEAD") {
          return respond(
            405,
            { errors: [] },
            { headers: { ...secure, allow: "GET, HEAD, OPTIONS" } },
          );
        }
        if (!read) throw unavailable();
        const session = await openSession(intake, keyOf(request), caller);
        const found = await thumbnailOf(session, params["id"] ?? "");
        const answer = await read(request, {
          organisationId: found.organisationId,
          key: found.storageKey,
          size: previewSize,
        });
        for (const [name, value] of Object.entries(secure)) {
          answer.headers.set(name, value);
        }
        if (caller.origin) {
          for (const [name, value] of Object.entries(
            corsHeaders(caller.origin),
          )) {
            answer.headers.set(name, value);
          }
        }
        return answer;
      } catch (caught) {
        return refusal(caught, caller, log);
      }
    },
  );
}

import { alxia, definePlugin } from "@alxia/core";
import type { MediaContext } from "@alxia/media";
import { can, requirePermission } from "../../core/access";
import { fail } from "../../core/shared/errors";
import type { Viewer } from "../../http/context";
import { clientHeader } from "../../http/csrf";
import {
  type Media,
  type MediaDeps,
  mediaUnavailable,
  refusalBody,
} from "../attachments/public";
import { fileNotFound } from "./intake.errors";
import { fileKindName, pdfSize, previewSize } from "./intake.files.kinds";
import { reportFilesRoutes } from "./intake.files.routes";
import { respond } from "./intake.http";

const SIZES = ["full", pdfSize, previewSize] as const;
type Size = (typeof SIZES)[number];

// The reads of the `report-files` kind, one request at a time: the caller
// has decided who may read (the team's guard, the tracking token) and names the
// organisation's folder; the kind's own read route serves the object (Range,
// ETag, `nosniff`, `sandbox`). No write goes through it.
export function reportFileReader(media: Media) {
  const granted = new WeakMap<Request, string>();
  const store = alxia().plugin(
    reportFilesRoutes({
      media,
      prefix: "/media",
      authorizeWrite: () => false,
      authorizeRead: ({ request }: MediaContext<object>) =>
        granted.has(request),
      organisationOf: ({ request }: MediaContext<object>) =>
        granted.get(request) ?? "",
      uploaded: () => {
        throw new Error("the read routes store nothing");
      },
    }),
  );
  return async (
    source: Request,
    where: { organisationId: string; key: string; size: Size },
    extra: { download?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers();
    for (const name of ["range", "if-none-match", "if-modified-since"]) {
      const value = source.headers.get(name);
      if (value) headers.set(name, value);
    }
    const forwarded = new Request(
      new URL(
        `/media/${fileKindName}/${where.key}${where.size === pdfSize ? "" : `/${where.size}`}`,
        source.url,
      ),
      { method: source.method === "HEAD" ? "HEAD" : "GET", headers },
    );
    granted.set(forwarded, where.organisationId);
    const found = await store.fetch(forwarded);
    // Nothing of a report file is cached or shared; a PDF is a download.
    const answer = new Response(found.body, found);
    answer.headers.set("cache-control", "private, no-store");
    if (extra.download) {
      answer.headers.set(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(extra.download)}`,
      );
    }
    return answer;
  };
}

const isSize = (size: string | undefined): size is Size =>
  (SIZES as readonly string[]).includes(size ?? "");

// GET /media/report-files/<key>/<size>: the team's read of a report file, for
// the UI server (the same CSRF header, Bearer token and `x-organization-id` as
// /media/attachments). In order: 403 `auth.errors.client-header-required`; 401
// `auth.errors.unauthenticated`; 503 `attachments.errors.unavailable` (no file
// store); the organisation and `attachment:read`; then the file itself. A file
// is read while a record carries its key: a quarantined one by those who
// triage (`issue:write`) only, a released one (its report was accepted) by
// every reader of the issues. Anyone else gets the 404
// `intake.errors.file-not-found` a missing key gets. A `<size>` the file has
// not (a PDF's `full`, a picture's `file`, a thumbnail it lacks) is that 404 too.
export function reportFilesReadRoutes(deps: MediaDeps) {
  const read = deps.media ? reportFileReader(deps.media) : undefined;
  return definePlugin<{ viewer: Viewer | null }>()((app) =>
    app.all(
      `/media/${fileKindName}/:key/:size`,
      async ({ request, viewer, params }) => {
        const answer = (error: unknown) => {
          const refusal = refusalBody(error);
          if (!refusal) throw error;
          return respond(refusal.status, refusal.body);
        };
        try {
          if (!request.headers.get(clientHeader)?.trim()) {
            throw fail("auth.errors.client-header-required", {
              params: { header: clientHeader },
              status: 403,
            });
          }
          if (!viewer) {
            throw fail("auth.errors.unauthenticated", { status: 401 });
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            return respond(405, { errors: [] });
          }
          if (!read || !deps.media) {
            throw mediaUnavailable();
          }
          const call = {
            request,
            viewer,
            access: deps.access,
            scope: deps.scopeOf(request, viewer),
          };
          const scope = await requirePermission(call, "attachment:read");
          const key = params["key"] ?? "";
          const size = params["size"];
          if (!isSize(size) || !/^[0-9a-f-]{36}$/.test(key)) {
            throw fileNotFound();
          }
          const file = await scope.mongo.db.clientReportFiles.findFirst({
            storageKey: key,
            state: { $in: ["quarantined", "released"] },
          });
          const has =
            file &&
            (file.mime === "application/pdf"
              ? size === pdfSize || (size === previewSize && file.previewKey)
              : size === "full" || (size === previewSize && file.previewKey));
          if (!file || !has) throw fileNotFound();
          if (
            file.state === "quarantined" &&
            !(await can(call, "issue:write"))
          ) {
            throw fileNotFound();
          }
          return await read(
            request,
            {
              organisationId: scope.tenant._id.toHexString(),
              key,
              size,
            },
            size === pdfSize ? { download: file.fileName } : {},
          );
        } catch (error) {
          return answer(error);
        }
      },
    ),
  );
}

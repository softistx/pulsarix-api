import { alxia } from "@alxia/core";
import type { MediaContext } from "@alxia/media";
import { GraphQLError } from "graphql";
import { addressKey } from "../../core/shared/address";
import { localeOfRequest } from "../../i18n/locale";
import type { Media } from "../attachments/public";
import { originNotAllowed, unavailable } from "./intake.errors";
import { dimensionsOf, maxFileBytes } from "./intake.files.kinds";
import { reportFilesRoutes } from "./intake.files.routes";
import { answerOf, corsHeaders, secure } from "./intake.http";
import { normaliseOrigin } from "./intake.origins";
import type { Caller, PublicIntake } from "./intake.submit";
import { TICKET_HEADER } from "./intake.tickets";
import { type Admission, ReportUploads } from "./intake.uploads";

const UPLOAD_PATH = "/public/media/report-files";

// PUT /public/media/report-files/<slot> (and its CORS preflight): the second
// half of a report with files. The widget sends each file as the raw body, with
// the ticket `submitClientReport` gave it in `x-pulsarix-ticket`, and the
// file's own `Content-Type` and `Content-Length`.
//
// Everything is checked by `ReportUploads.admit` before a byte of the body is
// read (the ticket, the key and `Origin`, the announced type and length, the
// byte limits, the slot, the quarantine); then the body goes, as it is, to
// the `report-files` kind of @alxia/media, which sniffs it, makes the
// renditions and stores them. Without a file store, 503.
export function uploadRoutes(
  intake: PublicIntake,
  media: Media | undefined,
  log = console.warn,
) {
  const uploads = new ReportUploads(intake);
  // The admission of each request handed to the media route: its guards read
  // it, and nothing reaches them that did not pass `admit`.
  const admitted = new WeakMap<Request, Admission>();
  const store = media
    ? alxia().plugin(
        reportFilesRoutes({
          media,
          prefix: "/public/media",
          authorizeWrite: ({ request }: MediaContext<object>) =>
            admitted.has(request),
          // Reads go through the team's own routes (A13), never this one.
          authorizeRead: () => false,
          organisationOf: ({ request }: MediaContext<object>) =>
            admitted.get(request)?.claims.organisationId ?? "",
          uploaded: async (stored, { request }: MediaContext<object>) => {
            const admission = admitted.get(request);
            if (!admission) throw new Error("no admission for this upload");
            await uploads.store(admission, stored, dimensionsOf(request));
            return { slot: admission.claims.slot, state: "received" };
          },
        }),
      )
    : undefined;

  return <App extends { all: (...args: never[]) => App }>(app: App): App =>
    (app as unknown as AnyApp).all(
      `${UPLOAD_PATH}/:slot`,
      { bodyLimit: maxFileBytes },
      async ({ request, reply, ip, params }: HandlerContext) => {
        const origin = request.headers.get("origin");
        const caller: Caller = {
          ip: addressKey(ip),
          origin,
          userAgent: null,
          language: localeOfRequest(),
          originGranted: false,
        };
        const refuse = (
          error: GraphQLError,
          extra: Record<string, string> = {},
        ) => {
          const { body, status } = answerOf(error, log);
          const retry = error.extensions["retryAfter"] as number | undefined;
          return reply(
            status,
            { errors: [body] },
            {
              headers: {
                ...secure,
                ...(retry !== undefined && { "retry-after": String(retry) }),
                ...(caller.originGranted && origin ? corsHeaders(origin) : {}),
                ...extra,
              },
            },
          );
        };
        try {
          if (request.method === "OPTIONS") {
            const known =
              origin !== null &&
              normaliseOrigin(origin) === origin &&
              (await intake.originKnown(origin, caller.ip));
            if (!known || !origin) throw originNotAllowed();
            return reply(204, undefined, {
              headers: {
                ...secure,
                ...corsHeaders(origin),
                "access-control-allow-methods": "PUT, OPTIONS",
                "access-control-allow-headers": `content-type, ${TICKET_HEADER}`,
                "access-control-max-age": "600",
              },
            });
          }
          if (request.method !== "PUT") {
            return reply(
              405,
              { errors: [] },
              { headers: { ...secure, allow: "PUT, OPTIONS" } },
            );
          }
          if (!store) throw unavailable();
          const admission = await uploads.admit(
            params["slot"] ?? "",
            request.headers.get(TICKET_HEADER),
            {
              contentType: request.headers.get("content-type"),
              length: request.headers.get("content-length"),
            },
            caller,
          );
          const cors =
            caller.originGranted && origin ? corsHeaders(origin) : {};
          if (admission.decoy) {
            // Nothing is read and nothing is stored.
            return reply(
              200,
              { slot: admission.claims.slot, state: "received" },
              { headers: { ...secure, ...cors } },
            );
          }
          const forwarded = new Request(new URL(UPLOAD_PATH, request.url), {
            method: "PUT",
            headers: {
              "content-type": request.headers.get("content-type") ?? "",
              "content-length": request.headers.get("content-length") ?? "",
            },
            body: request.body,
            duplex: "half",
          } as RequestInit);
          admitted.set(forwarded, admission);
          let stored: Response;
          try {
            stored = await store.fetch(forwarded);
          } catch (error) {
            await uploads.release(admission);
            throw error;
          }
          const body: unknown = await stored.json().catch(() => null);
          if (stored.status !== 200) await uploads.release(admission);
          const retry = stored.headers.get("retry-after");
          return reply(stored.status, body, {
            headers: {
              ...secure,
              ...cors,
              ...(retry && { "retry-after": retry }),
            },
          });
        } catch (error) {
          if (error instanceof GraphQLError) return refuse(error);
          if ((error as { status?: number }).status === 413) {
            return reply(413, { errors: [] }, { headers: secure });
          }
          log("report file upload failed", error);
          return refuse(
            new GraphQLError("Internal error", {
              originalError: error as Error,
            }),
          );
        }
      },
    ) as App;
}

interface HandlerContext {
  request: Request;
  ip: string | undefined;
  params: Record<string, string | undefined>;
  reply: (
    status: number,
    body?: unknown,
    init?: { headers?: Record<string, string> },
  ) => never;
}
// Elysia's route typing does not accept this handler shape through the
// generic plugin signature; the cast stays local to this one registration.
interface AnyApp {
  all: (
    path: string,
    options: { bodyLimit: number },
    handler: (ctx: HandlerContext) => unknown,
  ) => unknown;
}

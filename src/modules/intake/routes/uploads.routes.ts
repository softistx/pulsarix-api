import { alxia } from "@softistx/alxia";
import type { MediaContext } from "@softistx/alxia-media";
import { ObjectId } from "mongodb";
import { addressKey } from "../../../core/shared/address";
import { localeOfRequest } from "../../../i18n/locale";
import type { Media } from "../../attachments/public";
import { unavailable } from "../intake.errors";
import { maxFileBytes } from "../intake.files.kinds";
import { corsHeaders, respond, secure } from "../intake.http";
import type { Admission } from "../intake.types";
import type { Caller, PublicIntake } from "../services";
import { ReportUploads } from "../services";
import { readTicket, TICKET_HEADER } from "../utils/tickets.utils";
import { reportFilesRoutes } from "./files.routes";
import { failure, preflight, requireClientHeader } from "./uploads.http";

const UPLOAD_PATH = "/public/media/report-files";

// PUT /public/media/report-files/<slot> (and its CORS preflight): the second
// half of a report with files. The widget sends each file as the raw body, with
// the ticket `submitClientReport` gave it in `x-pulsarix-ticket`, and the
// file's own `Content-Type` and `Content-Length`.
//
// Everything is checked by `ReportUploads.admit` before a byte of the body is
// read (the ticket, the key and `Origin`, the announced type and length, the
// byte limits, the slot, the quarantine); then the body goes, as it is, to
// the `report-files` kind of @softistx/alxia-media, which sniffs it, makes the
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
  const store = media ? mediaStore(uploads, media, admitted) : undefined;
  return alxia().all(
    `${UPLOAD_PATH}/:slot`,
    { bodyLimit: maxFileBytes },
    (call) => handlePut({ intake, uploads, store, admitted, log }, call),
  );
}

// What one PUT needs: the intake, the admissions, the media store behind them.
interface PutParts {
  intake: PublicIntake;
  uploads: ReportUploads;
  store: ReturnType<typeof mediaStore> | undefined;
  admitted: WeakMap<Request, Admission>;
  log: (message: string, error?: unknown) => void;
}

// One request on the upload path: the preflight, the refusals, the admission,
// then the body handed to the media route.
async function handlePut(
  { intake, uploads, store, admitted, log }: PutParts,
  {
    request,
    ip,
    params,
  }: {
    request: Request;
    ip: string | undefined;
    params: Record<string, string | undefined>;
  },
) {
  const origin = request.headers.get("origin");
  const caller: Caller = {
    ip: addressKey(ip),
    origin,
    userAgent: null,
    language: localeOfRequest(),
    originGranted: false,
  };
  // The key a refusal is counted on (A13): the signed ticket's, and only
  // once the key's own `Origin` check has passed.
  const ticket = request.headers.get(TICKET_HEADER);
  const claims = ticket ? readTicket(intake.deps.ticketSecret, ticket) : null;
  const count = (error: unknown) => {
    if (claims && caller.originGranted) {
      intake.countRefusal(new ObjectId(claims.keyId), error);
    }
  };
  const cors = () =>
    caller.originGranted && origin ? corsHeaders(origin) : {};
  try {
    if (request.method === "OPTIONS") {
      return await preflight(intake, origin, caller.ip);
    }
    if (request.method !== "PUT") {
      return respond(
        405,
        { errors: [] },
        { headers: { ...secure, allow: "PUT, OPTIONS" } },
      );
    }
    if (!store) throw unavailable();
    if (claims?.tracking) requireClientHeader(request);
    const admission = await uploads.admit(
      params["slot"] ?? "",
      ticket,
      {
        contentType: request.headers.get("content-type"),
        length: request.headers.get("content-length"),
      },
      caller,
    );
    if (admission.decoy) {
      // Nothing is read and nothing is stored.
      return respond(
        200,
        { slot: admission.claims.slot, state: "received" },
        { headers: { ...secure, ...cors() } },
      );
    }
    return await forward(
      request,
      admission,
      { store, uploads, admitted },
      { cors: cors(), count },
    );
  } catch (error) {
    return failure(error, { count, cors: cors(), log });
  }
}

// The `report-files` routes of @softistx/alxia-media behind the admissions: a write
// only for a request `admit` passed, no read (the team's own routes read, A13).
function mediaStore(
  uploads: ReportUploads,
  media: Media,
  admitted: WeakMap<Request, Admission>,
) {
  return alxia().plugin(
    reportFilesRoutes({
      media,
      prefix: "/public/media",
      authorizeWrite: ({ request }: MediaContext<object>) =>
        admitted.has(request),
      authorizeRead: () => false,
      organisationOf: ({ request }: MediaContext<object>) =>
        admitted.get(request)?.claims.organisationId ?? "",
      uploaded: async (stored, { request }: MediaContext<object>) => {
        const admission = admitted.get(request);
        if (!admission) throw new Error("no admission for this upload");
        const full = stored.renditions.find((r) => r.size === "full");
        await uploads.store(
          admission,
          stored,
          full?.width && full.height
            ? { width: full.width, height: full.height }
            : undefined,
        );
        return { slot: admission.claims.slot, state: "received" };
      },
    }),
  );
}

// An admitted upload: the body goes on to the media route as it is, and a slot
// the upload did not fill is given back.
async function forward(
  request: Request,
  admission: Admission,
  parts: {
    store: ReturnType<typeof mediaStore>;
    uploads: ReportUploads;
    admitted: WeakMap<Request, Admission>;
  },
  answer: { cors: Record<string, string>; count: (error: unknown) => void },
) {
  const { store, uploads, admitted } = parts;
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
  if (stored.status !== 200) {
    await uploads.release(admission);
    // The media route's own refusals (type, size, pixels).
    answer.count({
      extensions: {
        code: (
          body as { errors?: { extensions?: { code?: unknown } }[] } | null
        )?.errors?.[0]?.extensions?.code,
      },
    });
  }
  const retry = stored.headers.get("retry-after");
  return respond(stored.status, body, {
    headers: {
      ...secure,
      ...answer.cors,
      ...(retry && { "retry-after": retry }),
    },
  });
}

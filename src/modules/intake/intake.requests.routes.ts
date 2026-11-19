import { alxia } from "@alxia/core";
import { GraphQLError } from "graphql";
import { realtime } from "../../config/redis";
import { addressKey } from "../../core/shared/address";
import { localeOfRequest } from "../../i18n/locale";
import type { Media } from "../attachments/public";
import {
  keyDisabled,
  originNotAllowed,
  tooManyRequests,
  unavailable,
} from "./intake.errors";
import { previewSize } from "./intake.files.kinds";
import { reportFileReader } from "./intake.files.read";
import {
  answerOf,
  corsHeaders,
  LIVE_REQUESTS_PATH,
  REQUEST_FILES_PATH,
  respond,
  secure,
} from "./intake.http";
import { IDENTITY_HEADER, verifyIdentity } from "./intake.identity";
import { normaliseOrigin } from "./intake.origins";
import {
  openSession,
  type RequestUpdate,
  thumbnailOf,
  unreadTotal,
  updateOf,
} from "./intake.requests";
import type { Caller, PublicIntake } from "./intake.submit";

// The identified reporter's two GET routes (plan §19, A17): the live stream of
// their requests and the thumbnails of their pictures. Both are read with
// `fetch`: the identity token is the `x-pulsarix-identity` header (never the
// URL, which logs keep) and the public key is the `key` query parameter. CORS
// is the key's: only an origin its list allows is answered with the CORS header.

// Open streams per reporter: more would be a script, not a person's tabs.
export const MAX_STREAMS = 3;
// A comment line keeps proxies from closing a quiet stream.
export const HEARTBEAT_MS = 20_000;
// How often an open stream re-reads its key and identity secret: a key revoked
// or deactivated, or a secret rotated, ends the stream within this delay. The
// object lets a spec shorten it.
export const streamTiming = { recheckMs: 30_000 };
// The count is per process: the cap holds with one API container only (as
// deployed). With several, a reporter could hold MAX_STREAMS on each.
const open = new Map<string, number>();

const callerOf = (request: Request, ip: string | undefined): Caller => ({
  ip: addressKey(ip),
  origin: request.headers.get("origin"),
  userAgent: request.headers.get("user-agent"),
  identity: request.headers.get(IDENTITY_HEADER),
  language: localeOfRequest(),
  originGranted: false,
});

const keyOf = (request: Request) =>
  new URL(request.url).searchParams.get("key") ?? "";

async function preflight(
  intake: PublicIntake,
  request: Request,
  ip: string | undefined,
) {
  const origin = request.headers.get("origin");
  const known =
    origin !== null &&
    normaliseOrigin(origin) === origin &&
    (await intake.originKnown(origin, addressKey(ip)));
  if (!known || !origin) throw originNotAllowed();
  return respond(204, undefined, {
    headers: {
      ...secure,
      ...corsHeaders(origin),
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "accept-language, x-pulsarix-identity",
      "access-control-max-age": "600",
    },
  });
}

function refusal(caught: unknown, caller: Caller, log: typeof console.warn) {
  let error: GraphQLError;
  if (caught instanceof GraphQLError) error = caught;
  else {
    log("public request read failed", caught);
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
        ...(caller.originGranted && caller.origin
          ? corsHeaders(caller.origin)
          : {}),
      },
    },
  );
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// GET /public/live/requests?key=pk_live_...: server-sent events for the
// reporter's requests. `unread {count}` first and after each change;
// `request.updated {id, publicState, unread}` when a request changed (the team
// replied, accepted, resolved, or the reporter did in another tab); comment
// pings; `expired {}` and the end of the stream when the token expires.
export function liveRequestRoutes(intake: PublicIntake, log = console.warn) {
  return alxia().all(LIVE_REQUESTS_PATH, async ({ request, ip }) => {
    const caller = callerOf(request, ip);
    try {
      if (request.method === "OPTIONS")
        return await preflight(intake, request, ip);
      if (request.method !== "GET") {
        return respond(
          405,
          { errors: [] },
          { headers: { ...secure, allow: "GET, OPTIONS" } },
        );
      }
      const publicKey = keyOf(request);
      const token = caller.identity as string;
      const session = await openSession(intake, publicKey, caller);
      const slot = `${session.reporter.keyId.toHexString()}:${session.reporter.reporterKey}`;
      if ((open.get(slot) ?? 0) >= MAX_STREAMS) {
        throw tooManyRequests(30_000);
      }
      const held = slot;
      const source = realtime.channels.reporterRequestChanged.stream(held);
      open.set(held, (open.get(held) ?? 0) + 1);
      const encoder = new TextEncoder();
      let finish = () => {};
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false;
          const timers: ReturnType<typeof setTimeout>[] = [];
          const send = (text: string) => {
            if (!closed) controller.enqueue(encoder.encode(text));
          };
          finish = () => {
            if (closed) return;
            closed = true;
            for (const timer of timers) clearTimeout(timer);
            clearInterval(beat);
            open.set(held, Math.max(0, (open.get(held) ?? 1) - 1));
            if ((open.get(held) ?? 0) === 0) open.delete(held);
            void source.return(undefined);
            try {
              controller.close();
            } catch {}
          };
          const beat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
          request.signal.addEventListener("abort", finish);
          // A key revoked or disabled, or an identity secret rotated, since the
          // stream opened ends it: the token alone is no longer proof.
          let rechecking = false;
          const recheck = setInterval(async () => {
            if (closed || rechecking) return;
            rechecking = true;
            try {
              const key = await intake.keyOf(publicKey);
              if (!key.active) throw keyDisabled();
              verifyIdentity(token, key, intake.now());
            } catch (error) {
              // A definite answer (key missing, revoked or inactive, secret
              // changed) ends the stream; the widget treats `expired` as
              // final. Anything else (a database blip) keeps it: the next
              // tick checks again.
              if (error instanceof GraphQLError) {
                send(frame("expired", {}));
                finish();
              } else {
                log("public request stream recheck failed", error);
              }
            } finally {
              rechecking = false;
            }
          }, streamTiming.recheckMs);
          timers.push(recheck as unknown as ReturnType<typeof setTimeout>);
          const left =
            session.identity.expiresAt.getTime() - intake.now().getTime();
          timers.push(
            setTimeout(
              () => {
                send(frame("expired", {}));
                finish();
              },
              Math.max(0, left),
            ),
          );
          send(": open\n\n");
          try {
            await source.ready?.();
            send(frame("unread", { count: await unreadTotal(session) }));
            for await (const event of source) {
              if (closed) break;
              const changed = await updateOf(session, event.reportId);
              if (!changed) continue;
              send(
                frame(
                  "request.updated",
                  changed.update satisfies RequestUpdate,
                ),
              );
              send(frame("unread", { count: changed.total }));
            }
          } catch (error) {
            if (!closed) log("public request stream failed", error);
          } finally {
            finish();
          }
        },
        cancel() {
          finish();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          ...secure,
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...(caller.origin ? corsHeaders(caller.origin) : {}),
        },
      });
    } catch (caught) {
      return refusal(caught, caller, log);
    }
  });
}

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

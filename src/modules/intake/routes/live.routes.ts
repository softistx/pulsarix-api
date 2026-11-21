import { alxia } from "@softistx/alxia";
import { GraphQLError } from "graphql";
import { realtime } from "../../../config/redis";
import { keyDisabled, tooManyRequests } from "../intake.errors";
import {
  corsHeaders,
  LIVE_REQUESTS_PATH,
  respond,
  secure,
} from "../intake.http";
import { verifyIdentity } from "../services/identity.service";
import {
  openLedger,
  type RequestUpdate,
} from "../services/requests-live.service";
import {
  openSession,
  type Session,
} from "../services/requests-session.service";
import type { Caller, PublicIntake } from "../services/submit.service";
import { callerOf, keyOf, preflight, refusal } from "./requests.http";

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

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// What one open stream is made of: the intake, the request, the reporter's
// session and slot (the cap's key), the public key and token, the log.
interface LiveStream {
  intake: PublicIntake;
  request: Request;
  session: Session;
  held: string;
  publicKey: string;
  token: string;
  caller: Caller;
  log: (message: string, error?: unknown) => void;
}

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
      const session = await openSession(intake, publicKey, caller);
      const held = `${session.reporter.keyId.toHexString()}:${session.reporter.reporterKey}`;
      if ((open.get(held) ?? 0) >= MAX_STREAMS) {
        throw tooManyRequests(30_000);
      }
      return openLiveStream({
        intake,
        request,
        session,
        held,
        publicKey,
        token: caller.identity as string,
        caller,
        log,
      });
    } catch (caught) {
      return refusal(caught, caller, log);
    }
  });
}

// The event stream of one reporter's tab: counted against the cap, pinged,
// re-checked against its key, ended by the token's expiry, and fed by the
// reporter's channel until it closes.
function openLiveStream(live: LiveStream): Response {
  const { request, session, held, caller, log } = live;
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
      timers.push(
        ...watchSession(live, {
          closed: () => closed,
          expired: () => {
            send(frame("expired", {}));
            finish();
          },
        }),
      );
      send(": open\n\n");
      try {
        await source.ready?.();
        const ledger = await openLedger(session);
        send(frame("unread", { count: ledger.total() }));
        for await (const event of source) {
          if (closed) break;
          const changed = await ledger.update(event.reportId);
          if (!changed) continue;
          send(
            frame("request.updated", changed.update satisfies RequestUpdate),
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
}

// The two clocks that end a stream: the periodic re-check of its key and
// identity secret, and the token's expiry. Both call `expired` (the widget
// treats it as final). Returns the timers, for the stream to clear.
function watchSession(
  live: LiveStream,
  hooks: { closed: () => boolean; expired: () => void },
): ReturnType<typeof setTimeout>[] {
  const { intake, session, publicKey, token, log } = live;
  // A key revoked or disabled, or an identity secret rotated, since the stream
  // opened ends it: the token alone is no longer proof.
  let rechecking = false;
  const recheck = setInterval(async () => {
    if (hooks.closed() || rechecking) return;
    rechecking = true;
    try {
      const key = await intake.keyOf(publicKey);
      if (!key.active) throw keyDisabled();
      verifyIdentity(token, key, intake.now());
    } catch (error) {
      // A definite answer (key missing, revoked or inactive, secret changed)
      // ends the stream. Anything else (a database blip) keeps it: the next
      // tick checks again.
      if (error instanceof GraphQLError) hooks.expired();
      else log("public request stream recheck failed", error);
    } finally {
      rechecking = false;
    }
  }, streamTiming.recheckMs);
  const left = session.identity.expiresAt.getTime() - intake.now().getTime();
  return [
    recheck as unknown as ReturnType<typeof setTimeout>,
    setTimeout(hooks.expired, Math.max(0, left)),
  ];
}

import {
  type ChronixLinkClient,
  ChronixLinkError,
  type ChronixLinkFactory,
  ChronixUnavailableError,
  type ExternalRefInput,
  type LinkEntry,
  type LinkProject,
  type LinkTimer,
  type LogTimeInput,
  type RefTotal,
} from "../src/modules/time/chronix";

// An in-memory chronix link API, written against the contract (link-api.md §3
// schema, §4 errors, §5 client) until `@softistx/chronix-react/server/testing`
// is published. Temporary, until @softistx/chronix-react R0
// (softistx/chronix-ui#8): swap for its `createFakeChronixLink()`.
export function createFakeChronixLink(
  options: { organisationName?: string } = {},
) {
  // A link key is made in chronix for one application and one organisation of
  // it (`issueKey`); a revoked one is refused like an unknown one.
  const keys = new Map<string, { app: string; organisationId: string }>();
  const revoked = new Set<string>();
  // The e-mails that are members of the chronix organisation; null: all are.
  let members: Set<string> | null = null;
  const project: LinkProject = {
    id: "p1",
    name: "Pulsarix work",
    clientName: null,
    colour: "#336699",
  };
  const mapped = new Set<string>();
  const lockedDates = new Set<string>();
  const entries: (LinkEntry & { ref: ExternalRefInput | null })[] = [];
  const timers = new Map<
    string,
    LinkTimer & { ref: ExternalRefInput | null }
  >();
  let down = false;
  // The next call is refused with this code (any code of the contract's §4).
  let nextFailure: string | null = null;
  // The next `runningTimer` answers the timer, then it is gone (another
  // client stopped it between pulsarix's two calls).
  let vanishAfterRead = false;
  let sequence = 0;
  // Every call, to assert the actor and the reference passed.
  const calls: {
    op: string;
    key: string;
    actor: string | null;
    input?: unknown;
  }[] = [];

  const entryOf = (
    actor: string,
    input: LogTimeInput,
    ref: ExternalRefInput | null,
    durationSeconds: number,
  ): LinkEntry & { ref: ExternalRefInput | null } => ({
    id: `e${++sequence}`,
    memberId: `m-${actor}`,
    memberEmail: actor,
    memberName: actor,
    date: input.date,
    startedAt: null,
    endedAt: null,
    durationSeconds,
    description: input.description ?? null,
    project,
    partnerProjectId: input.partnerProjectId,
    billable: input.billable ?? true,
    source: "pulsarix",
    locked: false,
    ref,
  });

  function guard(
    key: string,
    actor: string | null,
    op: string,
    input?: unknown,
  ) {
    calls.push({ op, key, actor, ...(input !== undefined && { input }) });
    if (down) throw new ChronixUnavailableError("chronix is down");
    if (nextFailure) {
      const code = nextFailure;
      nextFailure = null;
      throw new ChronixLinkError(code, code);
    }
    if (!keys.has(key) || revoked.has(key)) {
      throw new ChronixLinkError("link.unauthenticated", "unknown key");
    }
    if (actor !== null && members && !members.has(actor)) {
      throw new ChronixLinkError("link.actor-not-member", "not a member");
    }
  }
  const mappedOrThrow = (id: string) => {
    if (!mapped.has(id)) {
      throw new ChronixLinkError("link.project-not-mapped", "not mapped");
    }
  };

  const factory: ChronixLinkFactory = ({ key }) => {
    const client: ChronixLinkClient = {
      async link() {
        guard(key, null, "link");
        return {
          partnerApp: keys.get(key)?.app ?? "pulsarix",
          partnerOrganisationId: keys.get(key)?.organisationId ?? "",
          organisationName: options.organisationName ?? "Acme Time",
          timeZone: "UTC",
        };
      },
      as(actor) {
        return {
          async runningTimer() {
            guard(key, actor, "runningTimer");
            const timer = timers.get(actor) ?? null;
            if (vanishAfterRead) {
              vanishAfterRead = false;
              timers.delete(actor);
            }
            return timer;
          },
          async startTimer(input) {
            guard(key, actor, "startTimer", input);
            mappedOrThrow(input.partnerProjectId);
            const running = timers.get(actor);
            let stopped: LinkEntry | null = null;
            if (running) {
              stopped = entryOf(
                actor,
                {
                  partnerProjectId: running.partnerProjectId ?? "",
                  date: "2026-11-13",
                  durationSeconds: 0,
                },
                running.ref,
                600,
              );
              entries.push(stopped as never);
            }
            const timer = {
              entryId: `t${++sequence}`,
              startedAt: "2026-11-13T10:00:00.000Z",
              project,
              partnerProjectId: input.partnerProjectId,
              description: input.description ?? null,
              externalRef: input.externalRef
                ? { kind: input.externalRef.kind, id: input.externalRef.id }
                : null,
              ref: input.externalRef ?? null,
            };
            timers.set(actor, timer);
            return { timer, stopped };
          },
          async stopTimer() {
            guard(key, actor, "stopTimer");
            const running = timers.get(actor);
            if (!running) return null;
            timers.delete(actor);
            const stopped = entryOf(
              actor,
              {
                partnerProjectId: running.partnerProjectId ?? "",
                date: "2026-11-13",
                durationSeconds: 0,
              },
              running.ref,
              300,
            );
            entries.push(stopped);
            return stopped;
          },
          async logTime(input) {
            guard(key, actor, "logTime", input);
            mappedOrThrow(input.partnerProjectId);
            if (lockedDates.has(input.date)) {
              throw new ChronixLinkError("period.locked", "locked");
            }
            const entry = entryOf(
              actor,
              input,
              input.externalRef ?? null,
              input.durationSeconds,
            );
            entries.push(entry);
            return entry;
          },
          async totals(refs) {
            guard(key, actor, "totals", refs);
            return refs.map((ref): RefTotal => {
              const mine = entries.filter(
                (e) => e.ref?.kind === ref.kind && e.ref.id === ref.id,
              );
              return {
                kind: ref.kind,
                id: ref.id,
                totalSeconds: mine.reduce((n, e) => n + e.durationSeconds, 0),
                actorSeconds: mine
                  .filter((e) => e.memberEmail === actor)
                  .reduce((n, e) => n + e.durationSeconds, 0),
                entryCount: mine.length,
                running: [...timers.values()].some(
                  (t) => t.ref?.kind === ref.kind && t.ref.id === ref.id,
                ),
              };
            });
          },
        };
      },
    };
    return client;
  };

  return {
    factory,
    calls,
    entries,
    // chronix down (network error, timeout, 5xx), and back.
    goDown: () => {
      down = true;
    },
    comeUp: () => {
      down = false;
    },
    // The next call is refused with this code of the contract's §4.
    failNext: (code: string) => {
      nextFailure = code;
    },
    // A timer started in chronix itself, with no external reference.
    startUntrackedTimer: (actor: string, partnerProjectId: string) => {
      timers.set(actor, {
        entryId: `t${++sequence}`,
        startedAt: "2026-11-13T10:00:00.000Z",
        project,
        partnerProjectId,
        description: null,
        externalRef: null,
        ref: null,
      });
    },
    // The next read of the running timer finds it, then it is gone.
    vanishAfterNextRead: () => {
      vanishAfterRead = true;
    },
    // An admin mapped a pulsarix project in chronix.
    mapProject: (partnerProjectId: string) => mapped.add(partnerProjectId),
    lockPeriod: (date: string) => lockedDates.add(date),
    // chronix made a link key for an organisation of an application.
    issueKey: (
      key: string,
      partner: { organisationId: string; app?: string },
    ) => {
      keys.set(key, { app: partner.app ?? "pulsarix", ...partner });
      revoked.delete(key);
    },
    revokeKey: (key: string) => revoked.add(key),
    restoreKey: (key: string) => revoked.delete(key),
    // Only these e-mails are members of the chronix organisation (null: all).
    setMembers: (emails: string[] | null) => {
      members = emails && new Set(emails);
    },
  };
}

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
  options: { organisationName?: string; keys?: string[] } = {},
) {
  const keys = new Set(options.keys ?? ["chx_link_good"]);
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
    memberId: actor,
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
    if (!keys.has(key)) {
      throw new ChronixLinkError("link.unauthenticated", "unknown key");
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
          partnerApp: "pulsarix",
          partnerOrganisationId: "org",
          organisationName: options.organisationName ?? "Acme Time",
          timeZone: "UTC",
        };
      },
      as(actor) {
        return {
          async runningTimer() {
            guard(key, actor, "runningTimer");
            return timers.get(actor) ?? null;
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
              ref: input.externalRef ?? null,
            };
            timers.set(actor, timer);
            return { timer, stopped };
          },
          async stopTimer() {
            guard(key, actor, "stopTimer");
            timers.delete(actor);
            return null;
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
                  .filter((e) => e.memberId === actor)
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
    // An admin mapped a pulsarix project in chronix.
    mapProject: (partnerProjectId: string) => mapped.add(partnerProjectId),
    lockPeriod: (date: string) => lockedDates.add(date),
    revokeKey: (key: string) => keys.delete(key),
    restoreKey: (key: string) => keys.add(key),
  };
}

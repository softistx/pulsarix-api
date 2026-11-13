// Temporary, until @softistx/chronix-react R0 (softistx/chronix-ui#8): swap for the package's client
//
// The chronix link API client (contract: chronix `docs/link-api.md`, §1 transport,
// §3 schema, §4 errors, §5 client). The names and shapes below are those of
// `@softistx/chronix-react/server`, so the swap is this file's removal: an import
// path change in `time.service.ts` and the specs' fake. Only the calls pulsarix
// makes are ported (no project mapping, no subscription).

export interface ExternalRefInput {
  kind: string;
  id: string;
  label: string;
  url?: string | null;
}
export interface ExternalRefKey {
  kind: string;
  id: string;
}
export interface LinkInfo {
  partnerApp: string;
  partnerOrganisationId: string;
  organisationName: string;
  timeZone: string;
}
export interface LinkProject {
  id: string;
  name: string;
  clientName: string | null;
  colour: string;
}
export interface LinkTimer {
  entryId: string;
  startedAt: string;
  project: LinkProject;
  partnerProjectId: string | null;
  description: string | null;
}
export interface LinkEntry {
  id: string;
  memberId: string;
  memberName: string;
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  description: string | null;
  project: LinkProject;
  partnerProjectId: string | null;
  billable: boolean;
  source: string;
  locked: boolean;
}
export interface RefTotal {
  kind: string;
  id: string;
  totalSeconds: number;
  actorSeconds: number;
  entryCount: number;
  running: boolean;
}
export interface StartTimerInput {
  partnerProjectId: string;
  externalRef?: ExternalRefInput;
  description?: string;
}
export interface StartTimerPayload {
  timer: LinkTimer;
  stopped: LinkEntry | null;
}
export interface LogTimeInput {
  partnerProjectId: string;
  externalRef?: ExternalRefInput;
  date: string;
  durationSeconds: number;
  startedAt?: string;
  description?: string;
  billable?: boolean;
}

// The client bound to one acting member (`X-Chronix-Actor`).
export interface ChronixActorClient {
  runningTimer(): Promise<LinkTimer | null>;
  startTimer(input: StartTimerInput): Promise<StartTimerPayload>;
  stopTimer(): Promise<LinkEntry | null>;
  logTime(input: LogTimeInput): Promise<LinkEntry>;
  totals(refs: readonly ExternalRefKey[]): Promise<RefTotal[]>;
}
export interface ChronixLinkClient {
  // Checks the key; no actor needed.
  link(): Promise<LinkInfo>;
  // `janusUserId` is the janus `sub`, pulsarix's account id.
  as(janusUserId: string): ChronixActorClient;
}
export interface ChronixLinkOptions {
  baseUrl: string;
  key: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

// A network error, a timeout or a 5xx: show "time unavailable".
export class ChronixUnavailableError extends Error {
  override name = "ChronixUnavailableError";
}
// Any code of the contract's §4, as `code`.
export class ChronixLinkError extends Error {
  override name = "ChronixLinkError";
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

// What the app builds a client with, so a spec swaps the HTTP one for a fake.
export type ChronixLinkFactory = (
  options: ChronixLinkOptions,
) => ChronixLinkClient;

const PROJECT = "id name clientName colour";
const ENTRY = `id memberId memberName date startedAt endedAt durationSeconds
  description partnerProjectId billable source locked project { ${PROJECT} }`;
const TIMER = `entryId startedAt partnerProjectId description project { ${PROJECT} }`;

interface GraphQLReply {
  data?: Record<string, unknown> | null;
  errors?: {
    message?: string;
    extensions?: { code?: string; retryAfterSeconds?: number };
  }[];
}

// The link API over GraphQL HTTP (§1): `POST <baseUrl>/link/graphql`, JSON,
// `Authorization: Link <key>`, `X-Chronix-Actor`.
export const createChronixLinkClient: ChronixLinkFactory = (options) => {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/link/graphql`;
  const timeoutMs = options.timeoutMs ?? 3000;

  async function call<T>(
    actor: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Link ${options.key}`,
          ...(actor && { "x-chronix-actor": actor }),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (cause) {
      throw new ChronixUnavailableError("chronix did not answer", { cause });
    }
    if (response.status >= 500) {
      throw new ChronixUnavailableError(`chronix answered ${response.status}`);
    }
    let reply: GraphQLReply;
    try {
      reply = JSON.parse(text) as GraphQLReply;
    } catch {
      throw new ChronixUnavailableError("chronix answered no JSON");
    }
    const failure = reply.errors?.[0];
    if (failure) {
      const code =
        failure.extensions?.code ??
        (response.status === 429 ? "rate-limited" : "unknown");
      throw new ChronixLinkError(
        code,
        failure.message ?? code,
        failure.extensions?.retryAfterSeconds,
      );
    }
    if (!reply.data) {
      throw new ChronixUnavailableError("chronix answered no data");
    }
    return reply.data as T;
  }

  return {
    async link() {
      const data = await call<{ link: LinkInfo }>(
        null,
        "{ link { partnerApp partnerOrganisationId organisationName timeZone } }",
      );
      return data.link;
    },
    as(actor) {
      return {
        async runningTimer() {
          return (
            await call<{ runningTimer: LinkTimer | null }>(
              actor,
              `{ runningTimer { ${TIMER} } }`,
            )
          ).runningTimer;
        },
        async startTimer(input) {
          return (
            await call<{ startTimer: StartTimerPayload }>(
              actor,
              `mutation($input: StartTimerInput!) { startTimer(input: $input) {
                timer { ${TIMER} } stopped { ${ENTRY} } } }`,
              { input },
            )
          ).startTimer;
        },
        async stopTimer() {
          return (
            await call<{ stopTimer: LinkEntry | null }>(
              actor,
              `mutation { stopTimer { ${ENTRY} } }`,
            )
          ).stopTimer;
        },
        async logTime(input) {
          return (
            await call<{ logTime: LinkEntry }>(
              actor,
              `mutation($input: LogTimeInput!) { logTime(input: $input) { ${ENTRY} } }`,
              { input },
            )
          ).logTime;
        },
        async totals(refs) {
          return (
            await call<{ totals: RefTotal[] }>(
              actor,
              `query($refs: [ExternalRefKey!]!) { totals(refs: $refs) {
                kind id totalSeconds actorSeconds entryCount running } }`,
              { refs },
            )
          ).totals;
        },
      };
    },
  };
};

// The factory the app runs with: the HTTP client; a spec gives its own
// (`createApp({ chronix })`).
let factory: ChronixLinkFactory = createChronixLinkClient;
export const useChronix = (next: ChronixLinkFactory | undefined) => {
  factory = next ?? createChronixLinkClient;
};
export const chronixClient = (options: ChronixLinkOptions) => factory(options);

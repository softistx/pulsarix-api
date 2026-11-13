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
  // chronix's own member id
  memberId: string;
  memberEmail: string;
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
  // `memberEmail`: the account's verified e-mail (`X-Chronix-Actor`).
  as(memberEmail: string): ChronixActorClient;
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
const ENTRY = `id memberId memberEmail memberName date startedAt endedAt durationSeconds
  description partnerProjectId billable source locked project { ${PROJECT} }`;
const TIMER = `entryId startedAt partnerProjectId description project { ${PROJECT} }`;

interface GraphQLReply {
  data?: Record<string, unknown> | null;
  errors?: {
    message?: string;
    extensions?: { code?: string; retryAfterSeconds?: number };
  }[];
}

type Call = <T>(
  actor: string | null,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

// The reply of chronix as data, or the error it stands for (§1, §4).
function readReply(status: number, text: string): Record<string, unknown> {
  if (status >= 500) {
    throw new ChronixUnavailableError(`chronix answered ${status}`);
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
      failure.extensions?.code ?? (status === 429 ? "rate-limited" : "unknown");
    throw new ChronixLinkError(
      code,
      failure.message ?? code,
      failure.extensions?.retryAfterSeconds,
    );
  }
  if (!reply.data)
    throw new ChronixUnavailableError("chronix answered no data");
  return reply.data;
}

// One request of the link API over GraphQL HTTP (§1): `POST <baseUrl>/link/graphql`,
// JSON, `Authorization: Link <key>`, `X-Chronix-Actor` (the actor's verified e-mail).
function caller(options: ChronixLinkOptions): Call {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/link/graphql`;
  const timeoutMs = options.timeoutMs ?? 3000;
  return async <T>(
    actor: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
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
    return readReply(response.status, text) as T;
  };
}

// The calls an acting member makes.
function actorClient(call: Call, actor: string): ChronixActorClient {
  const run = async <K extends string, T>(
    key: K,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => (await call<Record<K, T>>(actor, query, variables))[key];
  return {
    runningTimer: () => run("runningTimer", `{ runningTimer { ${TIMER} } }`),
    startTimer: (input) =>
      run(
        "startTimer",
        `mutation($input: StartTimerInput!) { startTimer(input: $input) {
          timer { ${TIMER} } stopped { ${ENTRY} } } }`,
        { input },
      ),
    stopTimer: () => run("stopTimer", `mutation { stopTimer { ${ENTRY} } }`),
    logTime: (input) =>
      run(
        "logTime",
        `mutation($input: LogTimeInput!) { logTime(input: $input) { ${ENTRY} } }`,
        { input },
      ),
    totals: (refs) =>
      run(
        "totals",
        `query($refs: [ExternalRefKey!]!) { totals(refs: $refs) {
          kind id totalSeconds actorSeconds entryCount running } }`,
        { refs },
      ),
  };
}

export const createChronixLinkClient: ChronixLinkFactory = (options) => {
  const call = caller(options);
  return {
    async link() {
      const data = await call<{ link: LinkInfo }>(
        null,
        "{ link { partnerApp partnerOrganisationId organisationName timeZone } }",
      );
      return data.link;
    },
    as: (memberEmail) => actorClient(call, memberEmail),
  };
};

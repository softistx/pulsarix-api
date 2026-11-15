import { createMemoryMailer } from "@softistx/mail";
import { coreMongo, tenancy } from "../src/config/db";
import { clientHeader } from "../src/http/csrf";
import type { Media } from "../src/modules/attachments/public";
import {
  intakeEmail,
  intakeIpKey,
  intakeKey,
  intakeOrganisation,
  intakeReadIp,
  intakeTrackingIp,
  intakeUploadIpKey,
  intakeUploadKey,
} from "../src/modules/intake/intake.limits";
import { serverIntake } from "../src/modules/intake/intake.server";
import {
  type IntakeLimits,
  type Limiter,
  PublicIntake,
  type ReportReceived,
} from "../src/modules/intake/intake.submit";
import { authApp, ownerWithOrganisation, uiOrigin } from "./auth";

// A rate limit that counts up to the production limit and then refuses, with a
// fixed wait: the same arithmetic as the real one for a spec that never waits.
function counting<P>(
  limit: number,
  key: (params: P) => string,
): Limiter<P> & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async consume(params, cost = 1) {
      const k = key(params);
      const n = (counts.get(k) ?? 0) + cost;
      counts.set(k, n);
      return n > limit
        ? { allowed: false, retryAfter: 90_000 }
        : { allowed: true, retryAfter: 0 };
    },
  };
}

export const TICKET_SECRET = "t".repeat(40);

// The eight limits at their production values (src/modules/intake/intake.limits.ts).
export function countingLimits() {
  return {
    intakeKey: counting(
      intakeKey.limit,
      (p: { publicKey: string }) => p.publicKey,
    ),
    intakeIpKey: counting(
      intakeIpKey.limit,
      (p: { ip: string; publicKey: string }) => `${p.ip}/${p.publicKey}`,
    ),
    intakeEmail: counting(
      intakeEmail.limit,
      (p: { digest: string }) => p.digest,
    ),
    intakeOrganisation: counting(
      intakeOrganisation.limit,
      (p: { organisationId: string }) => p.organisationId,
    ),
    intakeReadIp: counting(intakeReadIp.limit, (p: { ip: string }) => p.ip),
    intakeTrackingIp: counting(
      intakeTrackingIp.limit,
      (p: { ip: string }) => p.ip,
    ),
    intakeUploadIpKey: counting(
      intakeUploadIpKey.limit,
      (p: { ip: string; keyId: string }) => `${p.ip}/${p.keyId}`,
    ),
    intakeUploadKey: counting(
      intakeUploadKey.limit,
      (p: { keyId: string }) => p.keyId,
    ),
  } satisfies IntakeLimits;
}

let sites = 0;
// Each kit has an origin of its own: the keys of every spec live in one database.
const nextSite = () => {
  sites += 1;
  return `https://app${sites}.client.test`;
};

export const SubmitDocument = {
  id: "submitClientReport",
} as const;

// A form as a person fills it.
export const goodReport = (extra: Record<string, unknown> = {}) => ({
  title: "The save button does nothing",
  description: "I click it and nothing happens.",
  filledInMs: 20_000,
  ...extra,
});

// The app with its public intake over a memory mailer, a counting limiter and a
// recorded live channel; one organisation with a project and a widget key.
export async function intakeKit(
  options: {
    limits?: IntakeLimits | undefined;
    // Build the intake as the server does (`serverIntake`), so a report
    // reaches the real live channel instead of the `published` list.
    server?: boolean;
    // The file store the PUT route of the report files writes to.
    media?: Media;
  } = {},
) {
  const site = nextSite();
  const mailer = createMemoryMailer();
  const published: ReportReceived[] = [];
  const limits = "limits" in options ? options.limits : countingLimits();
  const intake = options.server
    ? serverIntake(tenancy, { limits, mailer, log: () => {} })
    : new PublicIntake({
        core: coreMongo,
        tenancy,
        limits,
        mailer,
        from: { name: "pulsarix", address: "noreply@pulsarix.test" },
        uiOrigin,
        ticketSecret: TICKET_SECRET,
        log: () => {},
        publish: async (event) => {
          published.push(event);
        },
      });
  const kit = authApp({
    intake,
    ...(options.media && { media: options.media }),
  });
  const { owner, organisation } = await ownerWithOrganisation(kit);
  const asOwner = kit.client(owner.token, { organisation: organisation.id });
  const { createProject: project } = await asOwner.call<{
    createProject: { id: string };
  }>(
    `mutation($input: CreateProjectInput!) { createProject(input: $input) { id } }`,
    {
      input: { key: "ABC", name: "Alpha" },
    },
  );
  const { createWidgetKey: key } = await asOwner.call<{
    createWidgetKey: { id: string; publicKey: string };
  }>(
    `mutation($input: CreateWidgetKeyInput!) { createWidgetKey(input: $input) { id publicKey } }`,
    {
      input: {
        projectId: project.id,
        label: "Site",
        allowedOrigins: [site],
      },
    },
  );

  // A request to /public/graphql as a browser of `origin` makes it.
  const post = (body: unknown, headers: Record<string, string | null> = {}) =>
    kit.app.fetch(
      new Request("https://api.pulsarix.test/public/graphql", {
        method: "POST",
        headers: Object.fromEntries(
          Object.entries({
            "content-type": "application/json",
            origin: site,
            ...headers,
          }).filter((entry): entry is [string, string] => entry[1] !== null),
        ),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const op = async (
    id: string,
    variables: Record<string, unknown>,
    headers: Record<string, string | null> = {},
  ) => {
    const response = await post({ id, variables }, headers);
    return {
      response,
      body: (await response.json().catch(() => null)) as {
        data?: Record<string, unknown> | null;
        errors?: { extensions?: Record<string, unknown> }[];
      } | null,
    };
  };
  const submit = (
    input: Record<string, unknown> = goodReport(),
    headers: Record<string, string | null> = {},
    publicKey = key.publicKey,
  ) => op("submitClientReport", { publicKey, input }, headers);
  const config = (
    headers: Record<string, string | null> = {},
    publicKey = key.publicKey,
  ) => op("widgetConfig", { publicKey }, headers);
  // The tracking page's read, as the UI server makes it (no Origin).
  const track = (token: string) =>
    op(
      "clientReportStatus",
      { token },
      { origin: null, [clientHeader]: "pulsarix-ui" },
    );
  return {
    site,
    kit,
    intake,
    limits,
    mailer,
    published,
    owner,
    organisation,
    project,
    key,
    asOwner,
    post,
    op,
    submit,
    config,
    track,
  };
}

export type IntakeKit = Awaited<ReturnType<typeof intakeKit>>;

export const codeOfBody = (
  body: { errors?: { extensions?: Record<string, unknown> }[] } | null,
) => body?.errors?.[0]?.extensions?.["code"];

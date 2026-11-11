import type { Address, Mailer } from "@softistx/mail";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppTenancy, CoreMongo, ModuleMongo } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { type FieldIssue, invalid } from "../../core/shared/errors";
import type { Locale } from "../../i18n/locale";
import { withoutMarkers } from "../comments/public";
import {
  keyDisabled,
  originNotAllowed,
  reportNotFound,
  tooFast,
  tooManyRequests,
  unavailable,
  unknownKey,
} from "./intake.errors";
import { trackingMail } from "./intake.mail";
import {
  type ClientReportDocument,
  PUBLIC_KEY,
  type ReportState,
  reportLocale,
  type WidgetKeyDocument,
} from "./intake.model";
import { originAllowed } from "./intake.origins";
import { stripControl } from "./intake.text";
import {
  emailDigest,
  newTrackingToken,
  parseTrackingToken,
} from "./intake.token";

// What the public endpoint asks of a rate limit: `consume` is the bound limit
// of @softistx/redis (src/modules/intake/intake.limits.ts).
export interface Limiter<P> {
  consume(
    params: P,
    cost?: number,
    options?: { timeoutMs?: number },
  ): Promise<{ allowed: boolean; retryAfter: number }>;
}

export interface IntakeLimits {
  intakeKey: Limiter<{ publicKey: string }>;
  intakeIpKey: Limiter<{ ip: string; publicKey: string }>;
  intakeEmail: Limiter<{ digest: string }>;
  intakeOrganisation: Limiter<{ organisationId: string }>;
  intakeReadIp: Limiter<{ ip: string }>;
  intakeTrackingIp: Limiter<{ ip: string }>;
}

export interface ReportReceived {
  organisationId: string;
  projectId: string;
  reportId: string;
  title: string;
  at: string;
}

export interface IntakeDeps {
  core: Pick<CoreMongo, "db" | "as">;
  tenancy: Pick<AppTenancy, "resolve" | "databaseOf">;
  // Absent without Redis: the public endpoint then refuses (503).
  limits: IntakeLimits | undefined;
  mailer: Mailer;
  from: Address;
  // pulsarix-ui's origin: the tracking link starts with it.
  uiOrigin: string;
  // The live event of the team's inbox (`clientReportReceived`).
  publish: (event: ReportReceived) => Promise<void>;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

// What the endpoint knows of the request that is not in the operation.
export interface Caller {
  // The client address (TRUSTED_PROXIES), "unknown" when there is none.
  ip: string;
  // The `Origin` header; null when there is none.
  origin: string | null;
  userAgent: string | null;
  language: Locale;
  // Set once the key's allow-list accepted `origin`: from then on the answer
  // carries the CORS headers, so the widget can read a 429 or a refusal too.
  originGranted: boolean;
}

export type IntakeMongo = ModuleMongo<"intake">;

// The fill time under which a form was not filled by a person (Q10).
export const MIN_FILL_MS = 3_000;
const METADATA_BYTES = 2_048;
const KEY_TOUCH_MS = 60_000;

const text = (max: number) =>
  z
    .string()
    .transform((value) => stripControl(value).trim())
    .pipe(z.string().min(1).max(max));

const input = z.object({
  title: text(200),
  description: text(10_000),
  email: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.union([z.literal(""), z.email().max(254)]))
    .nullish(),
  pageUrl: z.string().max(2_048).nullish(),
  locale: reportLocale.nullish(),
  metadata: z
    .array(
      z.object({
        key: text(64),
        value: z.string().transform(stripControl).pipe(z.string().max(512)),
      }),
    )
    .max(20)
    .nullish(),
  website: z.string().max(1_000).nullish(),
  filledInMs: z.number().int().min(0),
});

export type SubmitInput = z.input<typeof input>;

// The zod issues as the API's field refusals.
function refused(error: z.ZodError): never {
  const issues: FieldIssue[] = error.issues.map((issue) => ({
    path: issue.path.join("."),
    code:
      issue.code === "too_big"
        ? "validation.errors.too-long"
        : issue.code === "too_small"
          ? "validation.errors.required"
          : "validation.errors.invalid",
    ...(issue.code === "too_big" && { params: { max: Number(issue.maximum) } }),
  }));
  throw invalid(issues);
}

// A page URL as http(s) without credentials or fragment; null for anything else.
function pageUrlOf(given: string | null | undefined): string | null {
  if (!given) return null;
  try {
    const url = new URL(given);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.slice(0, 2_048);
  } catch {
    return null;
  }
}

export interface WidgetConfig {
  projectName: string | null;
  locale: Locale;
  enabled: boolean;
}

export interface Submitted {
  reportId: string;
  // Whether a tracking link was mailed.
  tracking: boolean;
}

export interface Tracked {
  state: ReportState;
  title: string;
  createdAt: Date;
  replies: { at: Date; body: string }[];
}

const MAX_REPLIES = 50;

// The public side of the intake: the widget's three reads and writes and the
// tracking page's. Nothing here trusts the caller. A key reads its own
// configuration and files reports for its own project; the `Origin` is checked
// against the key's allow-list on every call; every call is rate limited first;
// and each refusal names no more than it must.
export class PublicIntake {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: IntakeDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // Resolves once the e-mails sent in the background are out (a spec's).
  async settled() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private background(work: () => Promise<void>) {
    const run = work().catch((error) =>
      (this.deps.log ?? ((m, e) => console.warn(m, e)))(
        "intake background work failed",
        error,
      ),
    );
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  // 429 past the limit; 503 when the limit cannot be checked at all.
  private async limit<P>(
    pick: (limits: IntakeLimits) => Limiter<P>,
    params: P,
  ) {
    const { limits } = this.deps;
    if (!limits) throw unavailable();
    let result: { allowed: boolean; retryAfter: number };
    try {
      result = await pick(limits).consume(params, 1, { timeoutMs: 1_000 });
    } catch (error) {
      (this.deps.log ?? ((m, e) => console.warn(m, e)))(
        "intake rate limit unavailable",
        error,
      );
      throw unavailable();
    }
    if (!result.allowed) throw tooManyRequests(result.retryAfter);
  }

  // The first thing of every request that is not the tracking page's.
  guardAddress(ip: string) {
    return this.limit((l) => l.intakeReadIp, { ip });
  }

  // The answer to a CORS preflight: whether some live key allows this origin.
  async originKnown(origin: string, ip: string): Promise<boolean> {
    await this.guardAddress(ip);
    return this.deps.core.db.widgetKeys.exists({
      allowedOrigins: origin,
      active: true,
      revokedAt: null,
    });
  }

  private async keyOf(publicKey: string): Promise<WidgetKeyDocument> {
    if (!PUBLIC_KEY.test(publicKey)) throw unknownKey();
    const key = await this.deps.core.db.widgetKeys.findFirst({
      publicKey,
      revokedAt: null,
    });
    if (!key) throw unknownKey();
    return key;
  }

  private touch(key: WidgetKeyDocument) {
    const now = this.now();
    if (
      key.lastUsedAt &&
      now.getTime() - key.lastUsedAt.getTime() < KEY_TOUCH_MS
    ) {
      return;
    }
    this.background(async () => {
      await this.deps.core
        .as(SYSTEM_ACTOR)
        .db.widgetKeys.update(key._id, { lastUsedAt: now });
    });
  }

  // The organisation's database, as the system; the key's organisation must
  // still be active.
  private async databaseOf(key: WidgetKeyDocument): Promise<IntakeMongo> {
    const tenant = await this.deps.tenancy.resolve(
      key.organisationId.toHexString(),
    );
    if (!tenant) throw unknownKey();
    const mongo = await this.deps.tenancy.databaseOf(tenant.id);
    return mongo.as(SYSTEM_ACTOR) as unknown as IntakeMongo;
  }

  async config(publicKey: string, caller: Caller): Promise<WidgetConfig> {
    await this.guardAddress(caller.ip);
    const key = await this.keyOf(publicKey);
    if (!originAllowed(caller.origin, key.allowedOrigins)) {
      throw originNotAllowed();
    }
    caller.originGranted = true;
    this.touch(key);
    const mongo = await this.databaseOf(key);
    const project = await mongo.db.projects.findById(key.projectId);
    const enabled = key.active && !!project && !project.archivedAt;
    return {
      projectName: enabled && project ? project.name : null,
      locale: caller.language,
      enabled,
    };
  }

  async submit(
    publicKey: string,
    given: SubmitInput,
    caller: Caller,
  ): Promise<Submitted> {
    await this.guardAddress(caller.ip);
    const key = await this.keyOf(publicKey);
    if (!originAllowed(caller.origin, key.allowedOrigins)) {
      throw originNotAllowed();
    }
    caller.originGranted = true;
    await this.limit((l) => l.intakeIpKey, { ip: caller.ip, publicKey });
    await this.limit((l) => l.intakeKey, { publicKey });
    if (!key.active) throw keyDisabled();

    const parsed = input.safeParse(given);
    if (!parsed.success) refused(parsed.error);
    const report = parsed.data;
    const email = report.email ? report.email : null;
    if (email) {
      await this.limit((l) => l.intakeEmail, { digest: emailDigest(email) });
    }
    await this.limit((l) => l.intakeOrganisation, {
      organisationId: key.organisationId.toHexString(),
    });

    // A bot that fills the hidden field is told it worked, and nothing is kept.
    if (report.website) {
      return { reportId: new ObjectId().toHexString(), tracking: !!email };
    }
    if (report.filledInMs < MIN_FILL_MS) throw tooFast();
    const metadata = report.metadata ?? [];
    const bytes = metadata.reduce(
      (sum, { key: k, value }) =>
        sum + Buffer.byteLength(k) + Buffer.byteLength(value),
      0,
    );
    if (bytes > METADATA_BYTES) {
      throw invalid([
        {
          path: "metadata",
          code: "validation.errors.too-long",
          params: { max: METADATA_BYTES },
        },
      ]);
    }

    const mongo = await this.databaseOf(key);
    const project = await mongo.db.projects.findById(key.projectId);
    if (!project || project.archivedAt) throw keyDisabled();
    const organisationId = key.organisationId.toHexString();
    const tracking = email ? newTrackingToken(organisationId) : null;
    const created: ClientReportDocument = await mongo.db.clientReports.create({
      projectId: key.projectId,
      widgetKeyId: key._id,
      title: report.title,
      description: report.description,
      email,
      trackingTokenHash: tracking?.hash ?? null,
      state: "new",
      issueId: null,
      declineReason: null,
      pageUrl: pageUrlOf(report.pageUrl),
      userAgent: stripControl(caller.userAgent ?? "").slice(0, 512) || null,
      locale: report.locale ?? caller.language,
      metadata,
      decidedBy: null,
      decidedAt: null,
      closedAt: null,
      erasedAt: null,
    });
    this.touch(key);

    this.background(async () => {
      await this.deps.publish({
        organisationId,
        projectId: key.projectId.toHexString(),
        reportId: created.id,
        title: created.title,
        at: created.createdAt.toISOString(),
      });
    });
    if (email && tracking) {
      this.background(async () => {
        await this.deps.mailer.send({
          from: this.deps.from,
          to: { name: email, address: email },
          ...trackingMail({
            locale: created.locale,
            projectName: project.name,
            link: `${this.deps.uiOrigin}/track/${tracking.token}`,
          }),
        });
      });
    }
    return { reportId: created.id, tracking: !!email };
  }

  // The tracking page's read: the state, and the replies marked public. Nothing
  // else of the report or its issue leaves (no author, no id, no private
  // comment).
  async status(token: string, ip: string): Promise<Tracked> {
    await this.limit((l) => l.intakeTrackingIp, { ip });
    const parsed = parseTrackingToken(token);
    if (!parsed) throw reportNotFound();
    const tenant = await this.deps.tenancy.resolve(parsed.organisationId);
    if (!tenant) throw reportNotFound();
    const mongo = (await this.deps.tenancy.databaseOf(
      tenant.id,
    )) as unknown as IntakeMongo;
    const report = await mongo.db.clientReports.findFirst({
      trackingTokenHash: parsed.hash,
    });
    if (!report) throw reportNotFound();
    const replies = report.issueId
      ? await mongo.db.comments.findMany({
          filter: { issueId: report.issueId, public: true },
          sort: { _id: 1 },
          limit: MAX_REPLIES,
        })
      : [];
    return {
      state: report.state,
      title: report.title,
      createdAt: report.createdAt,
      replies: replies.map((reply) => ({
        at: reply.createdAt,
        body: withoutMarkers(reply.body),
      })),
    };
  }
}

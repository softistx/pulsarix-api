import type { Address, Mailer } from "@softistx/mail";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppTenancy, CoreMongo, ModuleMongo } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import { type FieldIssue, invalid } from "../../core/shared/errors";
import type { Locale } from "../../i18n/locale";
import { withoutMarkers } from "../comments/public";
import { countOnKey, reasonOf } from "./intake.counters";
import {
  attachmentsDisabled,
  fileNotFound,
  keyDisabled,
  originNotAllowed,
  reportNotFound,
  tooFast,
  tooManyRequests,
  unavailable,
  unknownKey,
} from "./intake.errors";
import { type CheckedFile, checkFiles, newSlot } from "./intake.files.input";
import { PENDING_SLOT_MINUTES } from "./intake.files.retention";
import { trackingMail } from "./intake.mail";
import {
  type ClientReportDocument,
  PUBLIC_KEY,
  type ReportFileRole,
  type ReportState,
  reportLocale,
  type WidgetKeyDocument,
} from "./intake.model";
import { originAllowed } from "./intake.origins";
import { stripControl } from "./intake.text";
import { signTicket } from "./intake.tickets";
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
  // Bytes (the `cost` of a consume), per address and key, and per key.
  intakeUploadIpKey: Limiter<{ ip: string; keyId: string }>;
  intakeUploadKey: Limiter<{ keyId: string }>;
}

export interface ReportReceived {
  organisationId: string;
  projectId: string;
  reportId: string;
  title: string;
  at: string;
}

export interface ReportFileReceived {
  organisationId: string;
  projectId: string;
  reportId: string;
  fileId: string;
  role: "screenshot" | "file";
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
  // The secret the upload tickets are signed with (see intake.tickets.ts).
  ticketSecret: string;
  // The live event of the team's inbox (`clientReportReceived`).
  publish: (event: ReportReceived) => Promise<void>;
  // The live event of a file that was stored (`clientReportFileReceived`).
  publishFile?: (event: ReportFileReceived) => Promise<void>;
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
  files: z
    .array(
      z.object({
        role: z.enum(["screenshot", "file"]),
        name: z.string(),
        type: z.string(),
        size: z.number().int(),
      }),
    )
    .nullish(),
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

// A page URL as http(s) without credentials, query or fragment; null for anything else.
function pageUrlOf(given: string | null | undefined): string | null {
  if (!given) return null;
  try {
    const url = new URL(given);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
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
  // Whether the widget shows its screenshot and file controls.
  attachments: boolean;
}

// One ticket per declared file, in the order declared: the widget PUTs the
// file to `/public/media/report-files/<slot>` with the ticket in
// `x-pulsarix-ticket` (intake.uploads.routes.ts).
export interface FileTicket {
  slot: string;
  role: CheckedFile["role"];
  ticket: string;
  expiresAt: Date;
}

export interface Submitted {
  reportId: string;
  // Whether a tracking link was mailed.
  tracking: boolean;
  files: FileTicket[];
}

// A file the reporter attached, as the tracking page shows it: its name and
// role, and whether a thumbnail can be read (a picture's 256 px rendition;
// never the original, never a PDF).
export interface TrackedFile {
  id: string;
  role: ReportFileRole;
  name: string;
  thumbnail: boolean;
}

export interface Tracked {
  state: ReportState;
  title: string;
  createdAt: Date;
  replies: { at: Date; body: string }[];
  files: TrackedFile[];
}

const MAX_REPLIES = 50;
// The states in which a report file has its bytes (a pending slot has none).
const STORED = ["quarantined", "released"] as const;
// The reporter gets a thumbnail of a picture only: a PDF's preview is not
// offered back.
const hasThumbnail = (file: { previewKey: string | null; mime: string }) =>
  file.previewKey !== null && file.mime !== "application/pdf";

// The public side of the intake: the widget's three reads and writes and the
// tracking page's. Nothing here trusts the caller. A key reads its own
// configuration and files reports for its own project; the `Origin` is checked
// against the key's allow-list on every call; every call is rate limited first;
// and each refusal names no more than it must.
export class PublicIntake {
  private readonly pending = new Set<Promise<void>>();

  // `deps` is read by the uploads too (intake.uploads.ts).
  constructor(readonly deps: IntakeDeps) {}

  now() {
    return this.deps.now?.() ?? new Date();
  }

  // Resolves once the e-mails sent in the background are out (a spec's).
  async settled() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  background(work: () => Promise<void>) {
    const run = work().catch((error) =>
      (this.deps.log ?? ((m, e) => console.warn(m, e)))(
        "intake background work failed",
        error,
      ),
    );
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  // 429 past the limit; 503 when the limit cannot be checked at all. `cost`
  // is what the call spends (the bytes of an upload; 1 otherwise). Also the
  // uploads' (intake.uploads.ts).
  async limit<P>(
    pick: (limits: IntakeLimits) => Limiter<P>,
    params: P,
    cost = 1,
  ) {
    const { limits } = this.deps;
    if (!limits) throw unavailable();
    let result: { allowed: boolean; retryAfter: number };
    try {
      result = await pick(limits).consume(params, cost, {
        timeoutMs: 1_000,
      });
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
      revokedAt: null,
    });
  }

  async keyOf(publicKey: string): Promise<WidgetKeyDocument> {
    if (!PUBLIC_KEY.test(publicKey)) throw unknownKey();
    const key = await this.deps.core.db.widgetKeys.findFirst({
      publicKey,
      revokedAt: null,
    });
    if (!key) throw unknownKey();
    return key;
  }

  touch(key: WidgetKeyDocument) {
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
  async databaseOf(key: WidgetKeyDocument): Promise<IntakeMongo> {
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
      attachments: enabled && key.attachmentsEnabled,
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

    // Every declared file is checked before anything is made (plan §17, A12);
    // a refusal is counted on the key (A13).
    const declaredFiles = report.files ?? [];
    let files: CheckedFile[];
    try {
      if (declaredFiles.length > 0 && !key.attachmentsEnabled) {
        throw attachmentsDisabled();
      }
      files = checkFiles(declaredFiles);
    } catch (error) {
      this.countRefusal(key._id, error);
      throw error;
    }

    // A bot that fills the hidden field is told it worked, and nothing is
    // kept: its tickets are decoys, signed like the others, whose PUT stores
    // nothing.
    if (report.website) {
      const reportId = new ObjectId().toHexString();
      return {
        reportId,
        tracking: !!email,
        files: files.map((file) =>
          this.ticketFor(key, reportId, newSlot(), file, true, this.expiry()),
        ),
      };
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
    const tickets: FileTicket[] = [];
    const expiresAt = this.expiry();
    for (const file of files) {
      const slot = await mongo.db.clientReportFiles.create({
        reportId: created._id,
        role: file.role,
        fileName: file.name,
        mime: file.type,
        size: file.size,
        storageKey: null,
        previewKey: null,
        width: null,
        height: null,
        state: "pending",
        expiresAt,
        claimedAt: null,
      });
      tickets.push(
        this.ticketFor(key, created.id, slot.id, file, false, expiresAt),
      );
    }

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
    return { reportId: created.id, tracking: !!email, files: tickets };
  }

  private expiry() {
    return new Date(this.now().getTime() + PENDING_SLOT_MINUTES * 60_000);
  }

  private ticketFor(
    key: WidgetKeyDocument,
    reportId: string,
    slot: string,
    file: CheckedFile,
    decoy: boolean,
    expiresAt: Date,
  ): FileTicket {
    return {
      slot,
      role: file.role,
      expiresAt,
      ticket: signTicket(this.deps.ticketSecret, {
        organisationId: key.organisationId.toHexString(),
        keyId: key._id.toHexString(),
        reportId,
        slot,
        type: file.type,
        size: file.size,
        expiresAt: expiresAt.getTime(),
        decoy,
      }),
    };
  }

  // The report a tracking token opens, with its organisation's database; 404
  // for a token that is malformed, unknown or erased.
  private async reportOf(token: string) {
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
    if (!report || report.erasedAt) throw reportNotFound();
    return { mongo, report, organisationId: parsed.organisationId };
  }

  // The tracking page's read: the state, the replies marked public, and the
  // reporter's own files (name, role, whether a thumbnail exists). Nothing else
  // of the report or its issue leaves (no author, no id, no private comment).
  async status(token: string, ip: string): Promise<Tracked> {
    await this.limit((l) => l.intakeTrackingIp, { ip });
    const { mongo, report } = await this.reportOf(token);
    const replies = report.issueId
      ? await mongo.db.comments.findMany({
          filter: { issueId: report.issueId, public: true },
          sort: { _id: 1 },
          limit: MAX_REPLIES,
        })
      : [];
    const files = await mongo.db.clientReportFiles.findMany({
      filter: { reportId: report._id, state: { $in: STORED } },
      sort: { _id: 1 },
    });
    return {
      state: report.state,
      title: report.title,
      createdAt: report.createdAt,
      replies: replies.map((reply) => ({
        at: reply.createdAt,
        body: withoutMarkers(reply.body),
      })),
      files: files.map((file) => ({
        id: file.id,
        role: file.role,
        name: file.fileName,
        thumbnail: hasThumbnail(file),
      })),
    };
  }

  // The thumbnail of one of the reporter's pictures: where it sits, once the
  // token, the file and the picture's kind are checked (the tracking page's
  // read limit applies). Never the original, never a PDF.
  async thumbnailOf(
    token: string,
    fileId: string,
    ip: string,
  ): Promise<{ organisationId: string; storageKey: string }> {
    await this.limit((l) => l.intakeTrackingIp, { ip });
    if (!/^[0-9a-f]{24}$/.test(fileId)) throw fileNotFound();
    const { mongo, report, organisationId } = await this.reportOf(token);
    const file = await mongo.db.clientReportFiles.findFirst({
      _id: new ObjectId(fileId),
      reportId: report._id,
      state: { $in: STORED },
    });
    if (!file?.storageKey || !hasThumbnail(file)) throw fileNotFound();
    return { organisationId, storageKey: file.storageKey };
  }

  // Counts a refusal of the file traffic on the key (A13), whatever its
  // reason is called; any error that is not one of the closed list is left
  // alone. In the background: a counter never fails the request.
  countRefusal(keyId: ObjectId, error: unknown) {
    const reason = reasonOf(
      (error as { extensions?: { code?: unknown } } | null)?.extensions?.code,
    );
    if (!reason) return;
    this.background(() =>
      countOnKey(this.deps.core.db.widgetKeys, keyId, { refusal: reason }),
    );
  }

  // Counts a file stored on the key (A13).
  countUpload(keyId: ObjectId) {
    this.background(() =>
      countOnKey(this.deps.core.db.widgetKeys, keyId, { upload: true }),
    );
  }
}

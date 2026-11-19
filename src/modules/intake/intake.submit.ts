import type { Address, Mailer } from "@softistx/mail";
import { ObjectId } from "mongodb";
import type { AppTenancy, CoreMongo, ModuleMongo } from "../../config/db";
import { SYSTEM_ACTOR } from "../../core/shared/actors";
import type { Locale } from "../../i18n/locale";
import { countOnKey, reasonOf } from "./intake.counters";
import {
  attachmentsDisabled,
  keyDisabled,
  originNotAllowed,
  tooFast,
  tooManyRequests,
  unavailable,
  unknownKey,
} from "./intake.errors";
import { type CheckedFile, checkFiles } from "./intake.files.input";
import { verifyIdentity } from "./intake.identity";
import { trackingMail } from "./intake.mail";
import {
  attachmentsOn,
  type ClientReportDocument,
  PUBLIC_KEY,
  type WidgetKeyDocument,
} from "./intake.model";
import { originAllowed } from "./intake.origins";
import {
  decoyTickets,
  type FileTicket,
  reserveSlots,
  ticketExpiry,
} from "./intake.slots";
import {
  checkMetadata,
  MIN_FILL_MS,
  pageUrlOf,
  refused,
  type SubmitInput,
  submitInput,
} from "./intake.submit.input";
import { stripControl } from "./intake.text";
import { emailDigest, newTrackingToken } from "./intake.token";
import {
  type Tracked,
  trackedStatus,
  trackedThumbnail,
} from "./intake.tracking";

export type { FileTicket } from "./intake.slots";
export { MIN_FILL_MS, type SubmitInput } from "./intake.submit.input";
export type { Tracked, TrackedFile } from "./intake.tracking";

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
  intakeReporter: Limiter<{ keyId: string; reporterKey: string }>;
  intakeReadIp: Limiter<{ ip: string }>;
  intakeTrackingIp: Limiter<{ ip: string }>;
  // Bytes (the `cost` of a consume), per address and key, and per key.
  intakeUploadIpKey: Limiter<{ ip: string; keyId: string }>;
  intakeUploadKey: Limiter<{ keyId: string }>;
  // One consume per decoy slot: a replayed decoy ticket is a 409 like a real one.
  intakeDecoySlot: Limiter<{ slot: string }>;
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
  // The `x-pulsarix-identity` header, when the host sent one (intake.identity.ts).
  identity?: string | null;
  language: Locale;
  // Set once the key's allow-list accepted `origin`: from then on the answer
  // carries the CORS headers, so the widget can read a 429 or a refusal too.
  originGranted: boolean;
}

export type IntakeMongo = ModuleMongo<"intake">;

const KEY_TOUCH_MS = 60_000;

export interface Submitted {
  reportId: string;
  // Whether a tracking link was mailed.
  tracking: boolean;
  files: FileTicket[];
}

export interface WidgetConfig {
  projectName: string | null;
  locale: Locale;
  enabled: boolean;
  // Whether the widget shows its screenshot and file controls.
  attachments: boolean;
}

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
      attachments: enabled && attachmentsOn(key),
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

    // A token that is sent must be good: a bad one is a 401 and nothing is
    // kept, not a report that silently loses its identity. No token, no change.
    const identity =
      caller.identity != null
        ? verifyIdentity(caller.identity, key, this.now())
        : null;
    if (identity) {
      await this.limit((l) => l.intakeReporter, {
        keyId: key.id,
        reporterKey: identity.reporterKey,
      });
    }

    const parsed = submitInput.safeParse(given);
    if (!parsed.success) refused(parsed.error);
    const report = parsed.data;
    // An identified report carries the e-mail the host vouched for; the form's
    // own is the fallback.
    const email = identity?.email ?? (report.email ? report.email : null);
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
      if (declaredFiles.length > 0 && !attachmentsOn(key)) {
        throw attachmentsDisabled();
      }
      files = checkFiles(declaredFiles);
    } catch (error) {
      this.countRefusal(key._id, error);
      throw error;
    }

    // A bot that fills the hidden field is told it worked, and nothing is
    // kept: its tickets are decoys, signed like the others, whose PUT stores
    // nothing (and which, like a real one, can be used once).
    if (report.website) {
      const reportId = new ObjectId().toHexString();
      return {
        reportId,
        tracking: !!email,
        files: decoyTickets(
          this.deps.ticketSecret,
          key,
          reportId,
          files,
          ticketExpiry(this.now()),
        ),
      };
    }
    if (report.filledInMs < MIN_FILL_MS) throw tooFast();
    const metadata = report.metadata ?? [];
    checkMetadata(metadata);

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
      reporterKey: identity?.reporterKey ?? null,
      reporterName: identity?.reporterName ?? null,
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
    const tickets = await reserveSlots(
      this.deps.ticketSecret,
      mongo,
      key,
      created,
      files,
      ticketExpiry(this.now()),
    );

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

  // The tracking page's read (intake.tracking.ts).
  status(token: string, ip: string): Promise<Tracked> {
    return trackedStatus(this, token, ip);
  }

  // The thumbnail of one of the reporter's pictures (intake.tracking.ts).
  thumbnailOf(token: string, fileId: string, ip: string) {
    return trackedThumbnail(this, token, fileId, ip);
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

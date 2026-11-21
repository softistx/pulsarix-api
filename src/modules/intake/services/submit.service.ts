import type { ObjectId } from "mongodb";
import { SYSTEM_ACTOR } from "../../../core/shared/actors";
import {
  originNotAllowed,
  tooManyRequests,
  unavailable,
  unknownKey,
} from "../intake.errors";
import type { IntakeLimits, Limiter } from "../intake.limits.types";
import type {
  Caller,
  IntakeDeps,
  IntakeMongo,
  Submitted,
  WidgetConfig,
} from "../intake.types";
import { PUBLIC_KEY, type WidgetKeyDocument } from "../models";
import { originAllowed } from "../rules/origins.rules";
import type { SubmitInput } from "../rules/submit-input.rules";
import { attachmentsOn } from "../utils/attachments.utils";
import { countOnKey, reasonOf } from "./counters.service";
import { submitReport } from "./submit-report.service";
import {
  type Tracked,
  trackedStatus,
  trackedThumbnail,
} from "./tracking.service";

export type { IntakeLimits, Limiter } from "../intake.limits.types";
export type {
  Caller,
  IntakeDeps,
  IntakeMongo,
  MessagePosted,
  ReportFileReceived,
  ReportReceived,
  Submitted,
  WidgetConfig,
} from "../intake.types";
export { MIN_FILL_MS, type SubmitInput } from "../rules/submit-input.rules";
export type { FileTicket } from "./slots.service";
export type { Tracked, TrackedFile } from "./tracking.service";

const KEY_TOUCH_MS = 60_000;

// The public side of the intake: the widget's three reads and writes and the
// tracking page's. Nothing here trusts the caller. A key reads its own
// configuration and files reports for its own project; the `Origin` is checked
// against the key's allow-list on every call; every call is rate limited first;
// and each refusal names no more than it must.
export class PublicIntake {
  private readonly pending = new Set<Promise<void>>();

  // `deps` is read by the uploads too (services/uploads.service.ts).
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
  // uploads' (services/uploads.service.ts).
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
    return mongo.as(SYSTEM_ACTOR);
  }

  // The first steps of the widget's calls: the address counted, the key found
  // and the origin checked against its allow-list.
  async admit(publicKey: string, caller: Caller): Promise<WidgetKeyDocument> {
    await this.guardAddress(caller.ip);
    const key = await this.keyOf(publicKey);
    if (!originAllowed(caller.origin, key.allowedOrigins)) {
      throw originNotAllowed();
    }
    caller.originGranted = true;
    return key;
  }

  async config(publicKey: string, caller: Caller): Promise<WidgetConfig> {
    const key = await this.admit(publicKey, caller);
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
    return submitReport(this, publicKey, given, caller);
  }

  // The tracking page's read (services/tracking.service.ts).
  status(token: string, ip: string): Promise<Tracked> {
    return trackedStatus(this, token, ip);
  }

  // The thumbnail of one of the reporter's pictures (services/tracking.service.ts).
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

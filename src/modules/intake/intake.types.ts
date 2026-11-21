import type { Address, Mailer } from "@softistx/mail";
import type { ObjectId } from "mongodb";
import type { AppTenancy, CoreMongo, ModuleMongo } from "../../config/db";
import type { Locale } from "../../i18n/locale";
import type { IntakeLimits, Limiter } from "./intake.limits.types";
import type { ClientReportDocument, ReportFileRole } from "./models";
import type { FileTicket } from "./services/slots.service";
import type { TicketClaims } from "./utils/tickets.utils";

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

export interface MessagePosted {
  organisationId: string;
  projectId: string;
  reportId: string;
  messageId: string;
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
  // The secret the upload tickets are signed with (see utils/tickets.utils.ts).
  ticketSecret: string;
  // The live event of the team's inbox (`clientReportReceived`).
  publish: (event: ReportReceived) => Promise<void>;
  // The live event of a file that was stored (`clientReportFileReceived`).
  publishFile?: (event: ReportFileReceived) => Promise<void>;
  // The live event of a reporter's message (`clientReportMessageReceived`).
  publishMessage?: (event: MessagePosted) => Promise<void>;
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
  // The `x-pulsarix-identity` header, when the host sent one (services/identity.service.ts).
  identity?: string | null;
  // The `x-pulsarix-tracking` header, on the tracking page's operations.
  tracking?: string | null;
  language: Locale;
  // Set once the key's allow-list accepted `origin`: from then on the answer
  // carries the CORS headers, so the widget can read a 429 or a refusal too.
  originGranted: boolean;
}

export type IntakeMongo = ModuleMongo<"intake">;

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

// What the PUT route knows once every check that needs no byte of the body
// has passed.
export interface Admission {
  claims: TicketClaims;
  decoy: boolean;
  mongo: IntakeMongo | null;
  projectId: string;
  role: ReportFileRole | null;
}

export interface ReportPage {
  nodes: ClientReportDocument[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface ReporterMailJob {
  organisationId: string;
  reportId: string;
}

// What the scheduling needs of a queue: the bound queue of @softistx/redis has it.
export interface ReporterMailQueue {
  add(
    data: ReporterMailJob,
    options: { id: string; delay: number },
  ): Promise<{ deduplicated: boolean }>;
}

// What a job reaches outside the organisation's database.
export interface ReporterMailDeps {
  mongo(organisationId: string): Promise<IntakeMongo>;
  mailer: Mailer;
  from: Address;
  uiOrigin: string;
  // The allow-list of the widget key a report came in through.
  allowedOrigins(widgetKeyId: ObjectId): Promise<readonly string[]>;
  // The key unsubscribe links are signed with (`unsubscribeSecret`).
  secret: string;
}

export type ReporterMailOutcome = "sent" | "nothing" | "skipped";

// What the submit helpers (utils/submit.utils.ts) ask of `PublicIntake`: its
// shape, so the utils do not import the service.
export interface SubmitPort {
  deps: Pick<IntakeDeps, "mailer" | "from" | "uiOrigin">;
  background(work: () => Promise<void>): void;
  countRefusal(keyId: ObjectId, error: unknown): void;
  limit<P>(
    pick: (limits: IntakeLimits) => Limiter<P>,
    params: P,
    cost?: number,
  ): Promise<void>;
}

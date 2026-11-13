import type { Address, Mailer } from "@softistx/mail";
import { realtime } from "../../config/redis";
import type { Locale } from "../../i18n/locale";
import { digestMail } from "./notifications.mail";
import type { NotificationsMongo } from "./notifications.service";

// How long after a notification the member's digest is mailed: what they read
// meanwhile is left out.
export const DIGEST_DELAY_MS = 15 * 60_000;

// The most notifications one digest reads out; the rest are counted. A
// digest carries at most this many plus `DIGEST_FETCH - DIGEST_LISTED` more.
export const DIGEST_LISTED = 25;
export const DIGEST_FETCH = 200;

export interface DigestJob {
  organisationId: string;
  recipientId: string;
}

// What the digest needs of a queue: the bound queue of @softistx/redis has it.
export interface DigestQueue {
  add(
    data: DigestJob,
    options: { id: string; delay: number },
  ): Promise<{ deduplicated: boolean }>;
}

let queue: DigestQueue | undefined = realtime.queues?.notificationDigest;

// Swaps the queue the digests are scheduled on (a spec's); answers a function
// that puts the previous one back.
export function useDigestQueue(next: DigestQueue | undefined): () => void {
  const previous = queue;
  queue = next;
  return () => {
    queue = previous;
  };
}

// Asks for the member's digest in DIGEST_DELAY_MS. One job per member and time
// window: notifications in the same window share it, and one arriving while the
// job runs falls in the next window. Without a queue (no Redis, outside
// production) no digest is sent.
export async function scheduleDigest(
  organisationId: string,
  recipientId: string,
  now = Date.now(),
): Promise<void> {
  if (!queue) return;
  const window = Math.floor(now / DIGEST_DELAY_MS);
  await queue.add(
    { organisationId, recipientId },
    {
      id: `digest:${organisationId}:${recipientId}:${window}`,
      delay: DIGEST_DELAY_MS,
    },
  );
}

export interface DigestAccount {
  name: string;
  email: string;
  locale?: Locale | undefined;
}

// What a digest reaches outside the organisation's database.
export interface DigestDeps {
  mongo(organisationId: string): Promise<NotificationsMongo>;
  // Null once the organisation is gone.
  organisationName(organisationId: string): Promise<string | null>;
  isMember(organisationId: string, accountId: string): Promise<boolean>;
  accounts(ids: string[]): Promise<Map<string, DigestAccount>>;
  mailer: Mailer;
  from: Address;
  uiOrigin: string;
}

export type DigestOutcome = "sent" | "nothing" | "skipped";

// Mails the member what they have neither read nor been mailed yet, and marks
// it mailed. "skipped": the organisation is gone, or the member left it or
// has no account any more. A mail that fails throws, and the queue retries the
// job; a retry after a failure between the send and the mark may mail twice
// (at least once, never lost).
export async function sendDigest(
  deps: DigestDeps,
  job: DigestJob,
): Promise<DigestOutcome> {
  const { organisationId, recipientId } = job;
  const [organisation, member] = await Promise.all([
    deps.organisationName(organisationId),
    deps.isMember(organisationId, recipientId),
  ]);
  if (organisation === null || !member) return "skipped";

  const mongo = await deps.mongo(organisationId);
  const pending = await mongo.db.notifications.findMany({
    filter: { recipientId, readAt: null, digestedAt: null },
    sort: { _id: 1 },
    limit: DIGEST_FETCH,
  });
  if (pending.length === 0) return "nothing";

  const listed = pending.slice(0, DIGEST_LISTED);
  const accounts = await deps.accounts([
    recipientId,
    ...new Set(listed.map((row) => row.actorId)),
  ]);
  const recipient = accounts.get(recipientId);
  if (!recipient) return "skipped";

  const mail = digestMail({
    locale: recipient.locale ?? "en",
    name: recipient.name,
    organisation,
    link: `${deps.uiOrigin}/notifications`,
    more: pending.length - listed.length,
    items: listed.map((row) => ({
      kind: row.kind,
      actor: accounts.get(row.actorId)?.name ?? null,
      issueKey: row.issueKey,
      issueTitle: row.issueTitle,
    })),
  });
  await deps.mailer.send({
    from: deps.from,
    to: { name: recipient.name, address: recipient.email },
    ...mail,
  });
  await mongo.db.notifications.updateMany(
    { _id: { $in: pending.map((row) => row._id) } },
    { digestedAt: new Date() },
  );
  return "sent";
}

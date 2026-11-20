import { ObjectId } from "mongodb";
import type { PublicState } from "../projects/public";
import { reportsOf } from "./intake.requests.read";
import type { Session } from "./intake.requests.session";
import { publicStatesOf, unreadOf } from "./intake.requests.state";

// What the live stream of a reporter's requests reads.

export interface RequestUpdate {
  id: string;
  publicState: PublicState;
  unread: number;
}

// The unread count of each of the reporter's requests, read once when the
// stream opens and kept up as events come: an event about one request
// recounts that request alone (not every request of the reporter), and the
// total follows from the ledger.
export interface UnreadLedger {
  total(): number;
  // What the stream tells about one changed request, read from the database;
  // null when it is gone, erased or not the reporter's.
  update(id: string): Promise<{ update: RequestUpdate; total: number } | null>;
}

const sum = (counts: Iterable<number>) =>
  [...counts].reduce((total, n) => total + n, 0);

export async function openLedger(session: Session): Promise<UnreadLedger> {
  const reports = await reportsOf(session);
  const counts = new Map(await unreadOf(session.mongo, reports));
  return {
    total: () => sum(counts.values()),
    async update(id) {
      const _id = /^[0-9a-f]{24}$/.test(id) ? new ObjectId(id) : null;
      const report = _id
        ? await session.mongo.db.clientReports.findFirst({
            _id,
            widgetKeyId: session.reporter.keyId,
            reporterKey: session.reporter.reporterKey,
          })
        : null;
      if (!report || report.erasedAt) {
        counts.delete(id);
        return null;
      }
      const [states, unread] = await Promise.all([
        publicStatesOf(session.mongo, [report]),
        unreadOf(session.mongo, [report]),
      ]);
      counts.set(id, unread.get(id) ?? 0);
      return {
        update: {
          id,
          publicState: states.get(id) ?? "received",
          unread: unread.get(id) ?? 0,
        },
        total: sum(counts.values()),
      };
    },
  };
}

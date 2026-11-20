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

// What the live stream tells about one changed request, read from the
// database; null when it is gone, erased or not the reporter's.
export async function updateOf(
  session: Session,
  id: string,
): Promise<{ update: RequestUpdate; total: number } | null> {
  const reports = await reportsOf(session);
  const report = reports.find((candidate) => candidate.id === id);
  if (!report) return null;
  const [states, unread] = await Promise.all([
    publicStatesOf(session.mongo, [report]),
    unreadOf(session.mongo, reports),
  ]);
  return {
    update: {
      id,
      publicState: states.get(id) ?? "received",
      unread: unread.get(id) ?? 0,
    },
    total: [...unread.values()].reduce((sum, n) => sum + n, 0),
  };
}

export async function unreadTotal(session: Session): Promise<number> {
  const unread = await unreadOf(session.mongo, await reportsOf(session));
  return [...unread.values()].reduce((sum, n) => sum + n, 0);
}

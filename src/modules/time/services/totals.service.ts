import {
  type ChronixLinkClient,
  isChronixLinkError,
  isChronixUnavailable,
  type RefTotal,
} from "@softistx/chronix-react/server";
import { ISSUE } from "../utils/ref.utils";
import type { TimeLink } from "./link.service";

// What the issue page shows of the time, never an error (see `TimeSpent`).
export type TimeSpentView =
  | { status: "UNLINKED" | "UNAVAILABLE" | "FORBIDDEN" }
  | {
      status: "AVAILABLE";
      totalSeconds: number;
      mySeconds: number;
      entryCount: number;
      running: boolean;
    };

const MAX_REFS = 100; // the contract's cap on `totals`

// The totals of these issues in one call per 100; an issue chronix did not
// answer for is absent. Never throws for chronix: the page degrades.
export async function issueTotals(
  link: TimeLink,
  actorEmail: string,
  emailVerified: boolean,
  issueIds: readonly string[],
): Promise<Map<string, TimeSpentView>> {
  const views = new Map<string, TimeSpentView>();
  const set = (status: "UNLINKED" | "UNAVAILABLE" | "FORBIDDEN") => {
    for (const id of issueIds) views.set(id, { status });
  };
  let client: ChronixLinkClient | null;
  try {
    client = await link.client();
  } catch {
    set("UNAVAILABLE");
    return views;
  }
  if (!client) {
    set((await link.document()) ? "UNAVAILABLE" : "UNLINKED");
    return views;
  }
  // chronix wants a verified actor on reads too: no call without one.
  if (!emailVerified) {
    set("FORBIDDEN");
    return views;
  }
  const me = client.as(actorEmail);
  try {
    for (let i = 0; i < issueIds.length; i += MAX_REFS) {
      const chunk = issueIds.slice(i, i + MAX_REFS);
      const rows = await me.totals(chunk.map((id) => ({ kind: ISSUE, id })));
      const byId = new Map<string, RefTotal>(rows.map((r) => [r.id, r]));
      for (const id of chunk) {
        const row = byId.get(id);
        views.set(
          id,
          row
            ? {
                status: "AVAILABLE",
                totalSeconds: row.totalSeconds,
                mySeconds: row.actorSeconds,
                entryCount: row.entryCount,
                running: row.running,
              }
            : { status: "UNAVAILABLE" },
        );
      }
    }
  } catch (error) {
    const forbidden =
      isChronixLinkError(error) &&
      (error.code === "link.actor-not-member" ||
        error.code === "link.forbidden");
    if (
      !forbidden &&
      !isChronixUnavailable(error) &&
      !isChronixLinkError(error)
    ) {
      throw error;
    }
    set(forbidden ? "FORBIDDEN" : "UNAVAILABLE");
  }
  return views;
}

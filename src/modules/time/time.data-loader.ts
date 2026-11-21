import type { LinkTimer } from "@softistx/chronix-react/server";
import DataLoader from "dataloader";
import type { TimeSpentView } from "./services";

// What the time loaders ask of the request: `totals` is null for a viewer
// without `time:read`, `timer` null without `time:write` (the guards are the
// caller's, so a spec swaps them).
export interface TimeReads {
  totals: () => Promise<
    ((ids: readonly string[]) => Promise<Map<string, TimeSpentView>>) | null
  >;
  timer: () => Promise<(() => Promise<LinkTimer | null>) | null>;
}

// Per request. `spent` is not cached: a document that logs or stops time and
// then reads the totals must read what the write left, not what was memoised
// before it; a batch is still one tick's reads, each issue asked once.
// `spent`: the issues of one list ask their totals together, one
// chronix call for 50 issues. `timer`: the viewer's running timer is one read
// whatever the issues asked about (key `"me"`); a failure is no timer.
export function timeLoaders(reads: TimeReads) {
  return {
    spent: new DataLoader<string, TimeSpentView>(
      async (ids) => {
        const totals = await reads.totals();
        if (!totals) return ids.map(() => ({ status: "FORBIDDEN" as const }));
        const views = await totals([...new Set(ids)]);
        return ids.map((id) => views.get(id) ?? { status: "UNAVAILABLE" });
      },
      { cache: false },
    ),
    timer: new DataLoader<"me", LinkTimer | null>(async (keys) => {
      let timer: LinkTimer | null = null;
      try {
        const running = await reads.timer();
        timer = running ? await running() : null;
      } catch {
        timer = null;
      }
      return keys.map(() => timer);
    }),
  };
}

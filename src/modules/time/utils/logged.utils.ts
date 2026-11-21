import type { LinkEntry } from "@softistx/chronix-react/server";

export const loggedOf = (entry: LinkEntry) => ({
  id: entry.id,
  date: entry.date,
  durationSeconds: entry.durationSeconds,
  description: entry.description,
  billable: entry.billable,
});

import { ObjectId } from "mongodb";
import { invalid } from "../../../core/shared/errors";
import { escapeRegex } from "../../../core/shared/regex";
import type { ClientReportDocument, ReportState } from "../models";

// The team's organisation-wide list of requests (A25).

// What the list narrows to. A field left out or empty does not narrow.
export interface InboxFilter {
  states?: readonly ReportState[] | null | undefined;
  types?:
    | readonly NonNullable<ClientReportDocument["type"]>[]
    | null
    | undefined;
  text?: string | null | undefined;
  clientWaiting?: boolean | null | undefined;
}

// The requests that come first: a reporter waits for the team, or nobody has
// decided yet.
export const FIRST_GROUP = {
  $or: [{ clientWaiting: true }, { state: "new" }],
} as const;
export const SECOND_GROUP = { $nor: FIRST_GROUP.$or } as const;

export const inFirstGroup = (
  report: Pick<ClientReportDocument, "clientWaiting" | "state">,
) => report.clientWaiting === true || report.state === "new";

// The Mongo filter of a project (all of them when `projectId` is null) and of
// the narrowing, group left out.
export function inboxFilter(
  projectId: ObjectId | null,
  filter: InboxFilter | null | undefined,
): Record<string, unknown>[] {
  // Erased requests are gone from the inbox and its counts.
  const all: Record<string, unknown>[] = [{ erasedAt: null }];
  if (projectId) all.push({ projectId });
  if (filter?.states?.length) all.push({ state: { $in: [...filter.states] } });
  if (filter?.types?.length) all.push({ type: { $in: [...filter.types] } });
  if (filter?.clientWaiting === true) all.push({ clientWaiting: true });
  if (filter?.clientWaiting === false)
    all.push({ clientWaiting: { $ne: true } });
  const text = filter?.text?.trim();
  if (text) {
    const pattern = new RegExp(escapeRegex(text), "i");
    all.push({ $or: [{ title: pattern }, { description: pattern }] });
  }
  return all;
}

// A page cursor: the group the last request was in (a first, b second) and
// its id, since the list reads the first group, then the second, newest first.
export const cursorOf = (report: ClientReportDocument) =>
  `${inFirstGroup(report) ? "a" : "b"}:${report.id}`;

export function parseCursor(after: string | null | undefined): {
  group: "a" | "b";
  id: ObjectId | null;
} {
  if (!after) return { group: "a", id: null };
  // The former cursor (a plain id): an inbox left open during the deploy
  // starts again from the first page.
  if (/^[0-9a-f]{24}$/.test(after)) return { group: "a", id: null };
  const match = /^([ab]):([0-9a-f]{24})$/.exec(after);
  if (!match) {
    throw invalid([{ path: "after", code: "validation.errors.invalid" }]);
  }
  return {
    group: match[1] as "a" | "b",
    id: new ObjectId(match[2]),
  };
}

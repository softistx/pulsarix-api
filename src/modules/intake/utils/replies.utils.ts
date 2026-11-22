import type { ReportLink } from "../services/linked-reports.service";

// The filter of the public comments a reporter reads on a request: those of
// every issue it is linked to, from that link's date on and after `after` (a
// read cursor or a mailing date). Null when the request has no issue.
export function publicCommentsFilter(
  links: readonly ReportLink[],
  after?: Date | null,
) {
  if (links.length === 0) return null;
  return {
    public: true as const,
    $or: links.map((link) => {
      const since = latest(link.since, after);
      return {
        issueId: link.issueId,
        ...(since && { createdAt: { $gt: since } }),
      };
    }),
  };
}

// The later of two optional dates, null when neither is set.
export function latest(
  a: Date | null | undefined,
  b: Date | null | undefined,
): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

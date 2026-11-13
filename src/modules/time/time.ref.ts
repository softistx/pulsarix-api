import { env } from "../../config/env";
import type { LinkTimer } from "./chronix";

// The kind of reference pulsarix gives chronix for an issue.
export const ISSUE = "issue";

// The issue as chronix references it (§3 `ExternalRefInput`): its stable id, a
// label that survives a move or a delete, and a deep link back.
export function refOf(issue: { id: string; key: string; title: string }) {
  return {
    kind: ISSUE,
    id: issue.id,
    label: `${issue.key} ${issue.title}`,
    url: `${env.UI_ORIGIN}/issues/${issue.key}`,
  };
}

// Whether this chronix timer runs on this issue (false for no timer, one with
// no reference, or one on another kind of reference or issue).
export function isOnIssue(
  timer: LinkTimer | null | undefined,
  issueId: string,
): timer is LinkTimer {
  const ref = timer?.externalRef;
  return Boolean(timer) && ref?.kind === ISSUE && ref.id === issueId;
}

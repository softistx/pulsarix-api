import type { Clock } from "@softistx/janus";
import { fail } from "../shared/errors";
import type { Viewer } from "./viewer";

// How recently the session must have proved who it is for a sensitive action
// (a role change, a removal): its sign-in, or the last step-up.
export const FRESH_FOR_MS = 10 * 60 * 1000;

// Refuses (403 `auth.errors.step-up-required`) a session whose last proof is
// older than `FRESH_FOR_MS`, or unknown. The client then asks `requestStepUp`
// and sends the code to `confirmStepUp`, which stamps the session.
export function requireFresh(viewer: Viewer, clock: Pick<Clock, "now">) {
  const at = viewer.authenticatedAt;
  if (!at || clock.now().getTime() - at.getTime() >= FRESH_FOR_MS) {
    throw fail("auth.errors.step-up-required", { status: 403 });
  }
}

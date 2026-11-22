import type { PublicState } from "../../projects/public";

// What a request's linked issues say together (plan §20.4), from the public
// state each issue's status maps to (a cancelled one maps to declined). Null
// when no issue could be read:
//  - in progress when any maps to in progress;
//  - resolved when every one maps to resolved or declined and at least one to
//    resolved;
//  - declined when all map to declined;
//  - otherwise received.
export function combineMapped(
  states: readonly (PublicState | null)[],
): PublicState | null {
  const known = states.filter((state): state is PublicState => state !== null);
  if (known.length === 0) return null;
  if (known.includes("inProgress")) return "inProgress";
  const open = known.some(
    (state) => state !== "resolved" && state !== "declined",
  );
  if (open) return "received";
  return known.includes("resolved") ? "resolved" : "declined";
}

// Whether a request still waits on the team: not resolved, not declined.
export const isWaitingState = (state: PublicState): boolean =>
  state !== "resolved" && state !== "declined";

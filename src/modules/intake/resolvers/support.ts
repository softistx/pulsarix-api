import type { Caller, PublicIntake } from "../services/submit.service";

// What a resolver of /public/graphql reads: the intake and who calls.
export interface PublicContext {
  intake: PublicIntake;
  caller: Caller;
}

// A reply's or a report's file tickets, their expiry as the wire carries it.
export const withIsoTickets = <T extends { files: { expiresAt: Date }[] }>(
  done: T,
) => ({
  ...done,
  files: done.files.map((file) => ({
    ...file,
    expiresAt: file.expiresAt.toISOString(),
  })),
});

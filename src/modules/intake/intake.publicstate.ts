import type { ModuleMongo } from "../../config/db";
import { type PublicState, publicStateOfStatus } from "../projects/public";
import type { ClientReportDocument } from "./models";

type StateMongo = ModuleMongo<"intake">;

// The pieces of a report its public state is read from (plan §19, "Public
// states"). Reports stored before widget v3 lack the reporter's marks.
type Derivable = Pick<ClientReportDocument, "state"> &
  Partial<Pick<ClientReportDocument, "issueId">> &
  Partial<
    Pick<
      ClientReportDocument,
      "resolvedByReporterAt" | "reopenedAt" | "reopenedFrom"
    >
  >;

// A report's public state, in order. `mapped` is the public state of the
// report's issue's status, null when it has no issue:
//  1. declined when the report was declined, or its issue sits in a status
//     mapped to declined;
//  2. resolved when the reporter resolved it and has not reopened since;
//  3. in progress after a reopen, until the issue's mapped state next changes
//     (it is no longer the one the issue had at the reopen);
//  4. otherwise the issue's mapped state, or received (no issue yet).
export function derivePublicState(
  report: Derivable,
  mapped: PublicState | null,
): PublicState {
  if (report.state === "declined" || mapped === "declined") return "declined";
  const resolved = report.resolvedByReporterAt ?? null;
  const reopened = report.reopenedAt ?? null;
  if (resolved && (!reopened || reopened < resolved)) return "resolved";
  if (reopened && (report.reopenedFrom ?? null) === mapped) {
    return "inProgress";
  }
  // An issue that was set but is gone: the request was settled with it.
  if (mapped === null && report.issueId) return "resolved";
  return mapped ?? "received";
}

// The public state of the status an issue sits in, or null.
export async function mappedStateOf(
  mongo: StateMongo,
  issueId: ClientReportDocument["issueId"],
): Promise<PublicState | null> {
  if (!issueId) return null;
  const issue = await mongo.db.issues.findById(issueId);
  if (!issue) return null;
  const status = await mongo.db.statuses.findById(issue.statusId);
  return status ? publicStateOfStatus(status) : null;
}

export async function publicStateOf(
  mongo: StateMongo,
  report: ClientReportDocument,
): Promise<PublicState> {
  return derivePublicState(report, await mappedStateOf(mongo, report.issueId));
}

import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../../config/db";
import { type PublicState, publicStateOfStatus } from "../../projects/public";
import type { ClientReportDocument } from "../models";
import { combineMapped } from "../rules/client-state.rules";
import { linkedIssueIds } from "./linked-reports.service";

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
// report's linked issues together (`combineMapped`, A24), null when it has no
// issue:
//  1. declined when the report was declined, or all its issues are declined;
//  2. resolved when the reporter resolved it and has not reopened since;
//  3. in progress after a reopen, until the issues' mapped state next changes
//     (it is no longer the one they had at the reopen);
//  4. otherwise the issues' mapped state, or received (no issue yet).
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

// The public state of each issue's status, keyed by the issue's hex id (an
// unknown issue or status maps to null). One read of the issues, one of the
// statuses.
export async function mappedStatesOf(
  mongo: StateMongo,
  issueIds: readonly ObjectId[],
): Promise<Map<string, PublicState | null>> {
  const mapped = new Map<string, PublicState | null>();
  if (issueIds.length === 0) return mapped;
  const issues = await mongo.db.issues.findMany({
    filter: { _id: { $in: [...issueIds] } },
    limit: issueIds.length,
  });
  const statusIds = [...new Set(issues.map((i) => i.statusId.toHexString()))];
  const statuses = await mongo.db.statuses.findMany({
    filter: { _id: { $in: issues.map((issue) => issue.statusId) } },
    limit: statusIds.length,
  });
  const ofStatus = new Map(
    statuses.map((status) => [status.id, publicStateOfStatus(status)]),
  );
  for (const issue of issues) {
    mapped.set(issue.id, ofStatus.get(issue.statusId.toHexString()) ?? null);
  }
  return mapped;
}

// What a report's linked issues say together (`combineMapped`), null when it
// has none left to read.
export async function mappedStateOf(
  mongo: StateMongo,
  report: Pick<ClientReportDocument, "_id" | "id" | "issueId">,
): Promise<PublicState | null> {
  const ids = (await linkedIssueIds(mongo, [report])).get(report.id) ?? [];
  const mapped = await mappedStatesOf(mongo, ids);
  return combineMapped(ids.map((id) => mapped.get(id.toHexString()) ?? null));
}

export async function publicStateOf(
  mongo: StateMongo,
  report: ClientReportDocument,
): Promise<PublicState> {
  return derivePublicState(report, await mappedStateOf(mongo, report));
}

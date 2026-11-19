import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import type { ClientMarker } from "../issues/public";

// What a reporter did to an issue's requests, as the issue shows it (plan §19,
// A17): "resolved" and "reopened" replace each other (the latest wins),
// "deleted" is added beside them and stays. The issue's status never moves.
// Runs inside the caller's transaction; writes only when the markers change.
export async function markIssue(
  mongo: ModuleMongo<"issues">,
  issueId: ObjectId,
  marker: ClientMarker,
): Promise<void> {
  const issue = await mongo.db.issues.findById(issueId);
  if (!issue) return;
  const held = issue.clientMarkers ?? [];
  const opposite =
    marker === "resolved"
      ? "reopened"
      : marker === "reopened"
        ? "resolved"
        : null;
  const next: ClientMarker[] = [
    ...held.filter((m) => m !== marker && m !== opposite),
    marker,
  ];
  if (next.length === held.length && next.every((m) => held.includes(m))) {
    return;
  }
  await mongo.db.issues.update(issue._id, { clientMarkers: next });
}

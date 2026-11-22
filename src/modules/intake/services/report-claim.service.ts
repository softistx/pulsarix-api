import { OptimisticLockError } from "@softistx/mongo";
import { reportDecided } from "../intake.errors";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument } from "../models";

// What a decision may add to the report beside its state.
export type ClaimExtra = Partial<
  Pick<
    ClientReportDocument,
    "declineReason" | "declineReasonPublic" | "issueId" | "linkedAt"
  >
>;

// Decides a new report: the state change is claimed first, with the version
// read, so two members deciding at once cannot both win (the loser gets 409).
// `mongo` is the organisation's handle or a transaction's.
export async function claimReport(
  mongo: Pick<IntakeMongo, "db">,
  viewerId: string,
  report: ClientReportDocument,
  state: "accepted" | "declined",
  extra: ClaimExtra = {},
): Promise<ClientReportDocument> {
  if (report.state !== "new") throw reportDecided();
  try {
    return await mongo.db.clientReports.update(report._id, {
      state,
      decidedBy: viewerId,
      decidedAt: new Date(),
      ...extra,
      version: report.version,
    });
  } catch (error) {
    if (error instanceof OptimisticLockError) throw reportDecided();
    throw error;
  }
}

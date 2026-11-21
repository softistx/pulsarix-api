import { ConflictError } from "@softistx/mongo";
import type { ModuleMongo } from "../../../config/db";
import type { IssuesService } from "../../issues/public";
import type { ClientReportDocument, ReportImpact, ReportType } from "../models";

type PrefillMongo = ModuleMongo<"intake">;
type IssueInput = Parameters<IssuesService["create"]>[0];

// What the reporter's impact prefills (plan §16, Q27): the priority of the
// issue an acceptance makes. Urgent stays the team's call, so a blocking
// request is High.
export const priorityOfImpact: Record<
  ReportImpact,
  NonNullable<IssueInput["priority"]>
> = {
  blocking: "high",
  annoying: "medium",
  minor: "low",
};

// The label a type becomes, made in the project on first use.
export const labelOfType: Record<ReportType, { name: string; colour: string }> =
  {
    bug: { name: "Bug", colour: "#ef4444" },
    question: { name: "Question", colour: "#3b82f6" },
    suggestion: { name: "Suggestion", colour: "#22c55e" },
  };

// The label of a type, case-insensitively matched so a team's own "bug" is
// reused, made when the project has none. Two acceptances racing for the first
// use end on the unique index and read the winner's.
async function typeLabelId(
  mongo: PrefillMongo,
  projectId: ClientReportDocument["projectId"],
  type: ReportType,
) {
  const wanted = labelOfType[type];
  const find = async () =>
    (
      await mongo.db.labels.findMany({
        filter: { projectId, name: wanted.name },
        collation: { locale: "en", strength: 2 },
        limit: 1,
      })
    )[0];
  const found = await find();
  if (found) return found.id;
  try {
    return (await mongo.db.labels.create({ projectId, ...wanted })).id;
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const winner = await find();
    if (!winner) throw error;
    return winner.id;
  }
}

// What an acceptance adds to the issue's input from the report: the priority
// of its impact (origin `client`, which becomes `team` once a member changes
// it) and its type's label. Nothing when the reporter said nothing.
export async function prefillOf(
  mongo: PrefillMongo,
  report: ClientReportDocument,
): Promise<Partial<IssueInput>> {
  return {
    ...(report.impact && {
      priority: priorityOfImpact[report.impact],
      priorityOrigin: "client" as const,
    }),
    ...(report.type && {
      labelIds: [await typeLabelId(mongo, report.projectId, report.type)],
    }),
  };
}

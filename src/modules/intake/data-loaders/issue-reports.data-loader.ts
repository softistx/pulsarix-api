import { toObjectId } from "@softistx/mongo";
import DataLoader from "dataloader";
import type { IntakeMongo } from "../intake.types";
import type { ClientReportDocument } from "../models";
import { isWaitingState } from "../rules/client-state.rules";
import { publicStatesOf, reportsOfIssues } from "../services";

// The requests linked to each issue (A24), per request context: keys are
// issue ids, and the issues of a page share one read of the links and one of
// the reports. Erased requests are left out. Not cached: links change during
// a request. `mongoOf` runs the read guard (once per batch).
export const issueReportsLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<string, ClientReportDocument[]>(
    async (ids) => {
      const found = await reportsOfIssues(
        await mongoOf(),
        ids.map((id) => toObjectId(id)),
      );
      return ids.map((id) => found.get(id) ?? []);
    },
    { cache: false },
  );

// How many requests linked to each issue still wait on the team: not resolved,
// not declined, not erased.
export const waitingClientsLoader = (mongoOf: () => Promise<IntakeMongo>) =>
  new DataLoader<string, number>(
    async (ids) => {
      const mongo = await mongoOf();
      const found = await reportsOfIssues(
        mongo,
        ids.map((id) => toObjectId(id)),
      );
      const all = [
        ...new Map(
          [...found.values()].flat().map((report) => [report.id, report]),
        ).values(),
      ];
      const states = await publicStatesOf(mongo, all);
      return ids.map(
        (id) =>
          (found.get(id) ?? []).filter((report) => {
            const state = states.get(report.id);
            return state !== undefined && isWaitingState(state);
          }).length,
      );
    },
    { cache: false },
  );

import type { IntakeMongo } from "../intake.types";
import { filesLoader } from "./files.data-loader";
import {
  issueReportsLoader,
  waitingClientsLoader,
} from "./issue-reports.data-loader";
import { linksLoader } from "./links.data-loader";
import { pendingLoader } from "./pending.data-loader";
import { publicStateLoader } from "./public-state.data-loader";

// The inbox's per-request loaders, one set per request context (see
// src/modules/data-loaders.ts). `mongoOf` runs the inbox guard; `readOf` the
// issue read guard, for what an issue shows every reader (`waitingClients`).
export const intakeLoaders = (
  mongoOf: () => Promise<IntakeMongo>,
  readOf: () => Promise<IntakeMongo>,
) => ({
  issueReports: issueReportsLoader(mongoOf),
  waitingClients: waitingClientsLoader(readOf),
  files: filesLoader(mongoOf),
  links: linksLoader(mongoOf),
  pending: pendingLoader(mongoOf),
  publicState: publicStateLoader(mongoOf),
});

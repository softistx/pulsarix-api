import type { IntakeMongo } from "../intake.types";
import { filesLoader } from "./files.data-loader";
import { linksLoader } from "./links.data-loader";
import { pendingLoader } from "./pending.data-loader";
import { publicStateLoader } from "./public-state.data-loader";

// The inbox's per-request loaders, one set per request context (see
// src/modules/data-loaders.ts). `mongoOf` runs the inbox guard.
export const intakeLoaders = (mongoOf: () => Promise<IntakeMongo>) => ({
  files: filesLoader(mongoOf),
  links: linksLoader(mongoOf),
  pending: pendingLoader(mongoOf),
  publicState: publicStateLoader(mongoOf),
});

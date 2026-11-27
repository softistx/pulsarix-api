import { defineModule } from "@softistx/alxia-modules";
import { defineCodes } from "../../i18n/define-codes";
import { registerActiveSprint } from "../issues/public";
import { registerSprintsOffCheck } from "../projects/public";
import { activeSprint } from "./sprints.errors";
import sprintsTypeDefs from "./sprints.graphqls" with { type: "text" };
import { sprintSnapshots, sprints } from "./sprints.model";
import { sprintsResolvers } from "./sprints.resolver";
import type { SprintsMongo } from "./sprints.types";

// The issue list's `activeSprint` filter asks which sprint runs.
registerActiveSprint(async (mongo, projectId) => {
  const active = await (mongo as unknown as SprintsMongo).db.sprints.findFirst({
    projectId,
    state: "active",
  });
  return active?._id ?? null;
});

// Sprints cannot be turned off while one is active.
registerSprintsOffCheck(async (mongo, projectId) => {
  const running = await (mongo as unknown as SprintsMongo).db.sprints.exists({
    projectId,
    state: "active",
  });
  if (running) throw activeSprint();
});

// Sprints (plan §28): the iterations of a project, planning issues into them,
// starting and closing. Issues carry `sprintId` and `planRank` (issues module,
// which this one asks to write them); the project holds the on/off switch and
// the default length.
export const sprintsModule = defineModule({
  name: "sprints",
  dependsOn: ["access", "organisations", "projects", "issues", "activity"],
  collections: { sprints, sprintSnapshots },
  typeDefs: [sprintsTypeDefs],
  resolvers: sprintsResolvers as never,
  permissions: ["sprint:read", "sprint:write"],
  defaultGrants: {
    admin: ["sprint:read", "sprint:write"],
    member: ["sprint:read", "sprint:write"],
    viewer: ["sprint:read"],
  },
  codes: defineCodes("sprints", [
    "disabled",
    "not-found",
    "active-exists",
    "not-active",
    "not-planned",
    "closed",
    "type-not-allowed",
    "active-sprint",
  ]),
});

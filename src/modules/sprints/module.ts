import { defineModule } from "@softistx/alxia-modules";
import { defineCodes } from "../../i18n/define-codes";
import { registerSprintHooks } from "./services/hooks.service";
import sprintsTypeDefs from "./sprints.graphqls" with { type: "text" };
import { sprintSnapshots, sprints } from "./sprints.model";
import { sprintsResolvers } from "./sprints.resolver";

registerSprintHooks();

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

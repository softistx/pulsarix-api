import { defineModule } from "@alxia/modules";
import { defineCodes } from "../../i18n/define-codes";
import projectsTypeDefs from "./projects.graphqls" with { type: "text" };
import { labels, projects, statuses } from "./projects.model";
import { projectsResolvers } from "./projects.resolver";

// The projects of an organisation with their workflow (statuses) and labels,
// in the organisation's database.
export const projectsModule = defineModule({
  name: "projects",
  dependsOn: ["access", "organisations"],
  collections: { projects, statuses, labels },
  typeDefs: [projectsTypeDefs],
  resolvers: projectsResolvers as never,
  permissions: ["project:read", "project:manage"],
  defaultGrants: {
    admin: ["project:read", "project:manage"],
    member: ["project:read"],
    viewer: ["project:read"],
  },
  codes: defineCodes("projects", [
    "not-found",
    "key-taken",
    "status-not-found",
    "status-name-taken",
    "status-in-use",
    "label-not-found",
    "label-name-taken",
  ]),
});

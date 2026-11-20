import { defineModule } from "@alxia/modules";
import dashboardTypeDefs from "./dashboard.graphqls" with { type: "text" };
import { dashboardResolvers } from "./dashboard.resolver";

// Home in one query. It owns no collection: it reads the projects, issues,
// notifications and client reports of the other modules, and guards each
// section with the permission of the module that owns it (`issue:read`,
// `project:read`, `issue:write` for the triage).
export const dashboardModule = defineModule({
  name: "dashboard",
  dependsOn: [
    "access",
    "organisations",
    "projects",
    "issues",
    "notifications",
    "intake",
  ],
  typeDefs: [dashboardTypeDefs],
  resolvers: dashboardResolvers as never,
});

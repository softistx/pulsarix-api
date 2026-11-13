import { defineModule } from "@alxia/modules";
import searchTypeDefs from "./search.graphqls" with { type: "text" };
import { searchResolvers } from "./search.resolver";

// Search over issues, projects and members. It owns no collection: the text
// indexes sit on the issues and projects collections, and it guards nothing
// of its own, since each kind needs the permission of the module that owns it
// (`issue:read`, `project:read`, `member:read`).
export const searchModule = defineModule({
  name: "search",
  dependsOn: ["access", "organisations", "projects", "issues", "members"],
  typeDefs: [searchTypeDefs],
  resolvers: searchResolvers as never,
});

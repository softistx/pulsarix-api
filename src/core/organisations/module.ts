import { defineModule } from "@alxia/modules";
import organisationsTypeDefs from "./organisations.graphqls" with {
  type: "text",
};
import { organisations } from "./organisations.model";
import { organisations as resolvers } from "./organisations.resolver";

// The organisation registry (the tenant, plan Q2) in the core database. It
// declares no code of its own: a refused slug is `tenancy.errors.slug-taken`.
export const organisationsModule = defineModule({
  name: "organisations",
  dependsOn: ["access"],
  coreCollections: { organisations },
  typeDefs: [organisationsTypeDefs],
  resolvers: resolvers as never,
  permissions: ["organisation:read", "organisation:manage"],
  defaultGrants: {
    admin: ["organisation:read", "organisation:manage"],
    member: ["organisation:read"],
    viewer: ["organisation:read"],
  },
});

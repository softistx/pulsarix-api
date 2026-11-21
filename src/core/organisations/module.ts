import { defineModule } from "@softistx/alxia-modules";
import { defineCodes } from "../../i18n/define-codes";
import organisationsTypeDefs from "./organisations.graphqls" with {
  type: "text",
};
import { organisations, settings } from "./organisations.model";
import { organisations as resolvers } from "./organisations.resolver";

// The organisation registry (the tenant, plan Q2) in the core database. It
// declares one code, `too-many` (the cap of organisations an account owns); a
// refused slug is `tenancy.errors.slug-taken`.
export const organisationsModule = defineModule({
  name: "organisations",
  dependsOn: ["access"],
  coreCollections: { organisations },
  collections: { settings },
  typeDefs: [organisationsTypeDefs],
  resolvers: resolvers,
  codes: defineCodes("organisations", ["too-many"]),
  permissions: ["organisation:read", "organisation:manage"],
  defaultGrants: {
    admin: ["organisation:read", "organisation:manage"],
    member: ["organisation:read"],
    viewer: ["organisation:read"],
  },
});

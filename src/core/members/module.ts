import { defineModule } from "@alxia/modules";
import { defineCodes } from "../../i18n/define-codes";
import membersTypeDefs from "./members.graphqls" with { type: "text" };
import { memberLocks } from "./members.model";
import { membersResolvers } from "./members.resolver";

// The members of an organisation: janus accounts holding a role there (the
// relations live in the core database). Inviting is the invitations module's.
export const membersModule = defineModule({
  name: "members",
  dependsOn: ["access", "organisations"],
  coreCollections: { memberLocks },
  typeDefs: [membersTypeDefs],
  resolvers: membersResolvers as never,
  permissions: ["member:read", "member:manage"],
  defaultGrants: {
    admin: ["member:read", "member:manage"],
    member: ["member:read"],
    viewer: ["member:read"],
  },
  codes: defineCodes("members", ["not-found", "last-owner", "owner-required"]),
});

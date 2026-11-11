import { defineModule } from "@alxia/modules";
import { codes } from "./invitations.errors";
import invitationsTypeDefs from "./invitations.graphqls" with { type: "text" };
import { invitations } from "./invitations.model";
import { invitationsResolvers } from "./invitations.resolver";

// Inviting people to an organisation by e-mail, in the core database, and
// accepting an invitation from its link (which makes or finds the account).
export const invitationsModule = defineModule({
  name: "invitations",
  dependsOn: ["access", "accounts", "organisations", "members"],
  coreCollections: { invitations },
  typeDefs: [invitationsTypeDefs],
  resolvers: invitationsResolvers as never,
  codes,
});

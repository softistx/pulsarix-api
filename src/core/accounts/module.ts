import { defineModule } from "@alxia/modules";
import typeDefs from "./accounts.graphqls" with { type: "text" };
import { accounts as resolvers } from "./accounts.resolver";

// The account flows over janus: sign-up, password, second factor, reset, magic
// link, step-up. The janus collections (users, sessions, tokens, relations)
// are janus-mongo's own and live in the core database (`tenancy.sync()` syncs
// them, src/config/db.ts).
export const accountsModule = defineModule({
  name: "accounts",
  dependsOn: ["access"],
  typeDefs: [typeDefs],
  resolvers: resolvers as never,
});

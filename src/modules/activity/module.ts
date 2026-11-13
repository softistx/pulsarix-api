import { defineModule } from "@alxia/modules";
import activityTypeDefs from "./activity.graphqls" with { type: "text" };
import { activities } from "./activity.model";
import { activityResolvers } from "./activity.resolver";
import "./activity.journal";

// The append-only journal of the issues and their comments, and the live
// subscriptions it feeds. It registers with the issues and comments modules
// (journal.ts), which tell it what they changed inside their transactions.
// Reading the journal and the live topics need `issue:read` (no permission of
// its own: who may read an issue may read its history).
export const activityModule = defineModule({
  name: "activity",
  dependsOn: ["access", "organisations", "projects", "issues", "comments"],
  collections: { activities },
  typeDefs: [activityTypeDefs],
  resolvers: activityResolvers as never,
});

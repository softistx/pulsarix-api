import { createSchema } from "@graxia/core";
import type { GraphQLSchema } from "graphql";
import type { PublicContext } from "./intake.public.context";
import { reporterMutation, reporterQuery } from "./intake.public.reporter";
import { trackingMutation, trackingQuery } from "./intake.public.tracking";
import { publicTypeDefs } from "./intake.public.typedefs";

export type { PublicContext } from "./intake.public.context";
export {
  type PersistedId,
  persistedOperations,
  trackingOperations,
} from "./intake.public.operations";
export { publicTypeDefs } from "./intake.public.typedefs";

// The schema of /public/graphql: a schema of its own, apart from /graphql's.
// Its types are in intake.public.typedefs.ts, the persisted operations the
// endpoint runs in intake.public.operations.ts, and the resolvers by caller:
// the widget's reporter (intake.public.reporter.ts) and the tracking page
// (intake.public.tracking.ts).
export function publicSchema(): GraphQLSchema {
  return createSchema<PublicContext>()({
    typeDefs: publicTypeDefs,
    // The endpoint runs graphql-js's `graphql()`, which serves no @defer or
    // @stream: the schema does not declare them.
    incremental: false,
    resolvers: {
      Query: { ...reporterQuery, ...trackingQuery },
      Mutation: { ...reporterMutation, ...trackingMutation },
    },
  });
}

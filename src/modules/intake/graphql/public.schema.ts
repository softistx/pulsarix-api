import { createSchema } from "@softistx/graxia";
import type { GraphQLSchema } from "graphql";
import {
  reporterMutation,
  reporterQuery,
} from "../resolvers/public-reporter.resolver";
import {
  trackingMutation,
  trackingQuery,
} from "../resolvers/public-tracking.resolver";
import type { PublicContext } from "../resolvers/support";
import { publicTypeDefs } from "./public.typedefs";

export type { PublicContext } from "../resolvers/support";
export {
  type PersistedId,
  persistedOperations,
  trackingOperations,
} from "./public.operations";
export { publicTypeDefs } from "./public.typedefs";

// The schema of /public/graphql: a schema of its own, apart from /graphql's.
// Its types are in graphql/public.typedefs.ts, the persisted operations the
// endpoint runs in graphql/public.operations.ts, and the resolvers by caller:
// the widget's reporter (resolvers/public-reporter.resolver.ts) and the tracking page
// (resolvers/public-tracking.resolver.ts).
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

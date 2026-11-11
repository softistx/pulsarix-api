import { StoreFailure } from "@softistx/janus";
import { GraphQLError } from "graphql";
import type { Plugin } from "graphql-yoga";
import { locationOf, reshaped } from "./constraints";
import { unavailable } from "./fail";

// The error a resolver's janus outage becomes: `auth.errors.unavailable`, at
// the field's location; any other error as it is.
function outage(error: GraphQLError): GraphQLError {
  if (!(error.originalError instanceof StoreFailure)) return error;
  const { message, extensions } = unavailable();
  return new GraphQLError(message, { ...locationOf(error), extensions });
}

// A Yoga plugin (src/app.ts): @constraint refusals (@nxgt/graphql-
// validation's BAD_USER_INPUT) and variables that cannot be coerced leave as
// every other invalid input does, and a
// janus outage as `auth.errors.unavailable` (503), not masked as a 500. It rewrites the
// execution's result rather than masking, since Yoga logs as an error every
// error a `maskError` replaces.
export const apiErrors: Plugin = {
  onExecute: () => ({
    onExecuteDone: ({ result, setResult }) => {
      if (!("errors" in result) || !result.errors) return;
      const changed = result.errors.map((error) => outage(reshaped(error)));
      if (changed.every((error, i) => error === result.errors?.[i])) return;
      setResult({ ...result, errors: changed });
    },
  }),
};

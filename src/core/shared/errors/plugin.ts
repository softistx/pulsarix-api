import { definePlugin } from "@graxia/core";
import { StoreFailure } from "@softistx/janus";
import { GraphQLError } from "graphql";
import { locationOf, reshaped } from "./constraints";
import { unavailable } from "./fail";

// The error a resolver's janus outage becomes: `auth.errors.unavailable`, at
// the field's location; any other error as it is.
function outage(error: GraphQLError): GraphQLError {
  if (!(error.originalError instanceof StoreFailure)) return error;
  const { message, extensions } = unavailable();
  return new GraphQLError(message, { ...locationOf(error), extensions });
}

type Errored = { errors: readonly GraphQLError[] };

// An execution's answer that carries errors (not a stream of results).
function errored<T extends object>(
  result: T | undefined,
): (T & Errored) | undefined {
  if (!result || Symbol.asyncIterator in result) return undefined;
  const errors = (result as { errors?: unknown }).errors;
  return Array.isArray(errors) ? (result as T & Errored) : undefined;
}

// The result with its errors reshaped, or undefined when nothing changed.
function rewritten<T extends Errored>(result: T): T | undefined {
  const changed = result.errors.map((error) => outage(reshaped(error)));
  if (changed.every((error, i) => error === result.errors[i])) return undefined;
  return { ...result, errors: changed };
}

// A graxia plugin (src/app.ts): @constraint refusals (@nxgt/graphql-
// validation's BAD_USER_INPUT) and variables that cannot be coerced leave as
// every other invalid input does, and a janus outage as
// `auth.errors.unavailable` (503), not masked as a 500. It rewrites the
// result rather than masking: graxia's `maskError` only sees the errors it
// masks, never a coded GraphQLError. A subscription's stream is not rewritten,
// only an answer given before it starts.
export const apiErrors = definePlugin({
  name: "pulsarix-api-errors",
  onExecute:
    () =>
    ({ result, setResult }) => {
      const found = errored(result);
      const next = found && rewritten(found);
      if (next) setResult(next);
    },
  onSubscribe:
    () =>
    ({ result, setResult }) => {
      const found = errored(result);
      const next = found && rewritten(found);
      if (next) setResult(next);
    },
});

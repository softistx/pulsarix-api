import type { ValidationIssue } from "@softistx/graphql-validation";
import { inputPath } from "@softistx/graphql-validation";
import { GraphQLError, type GraphQLErrorOptions, Kind } from "graphql";
import type { ErrorCode } from "../../../i18n/codes";
import type { Params } from "../../../i18n/params";
import { invalidInput } from "./fields";

// validation names the argument that refused in `issues[].constraint`, and the
// limit it was declared with in `issues[].value`.
const constraintCodes: Record<string, ErrorCode> = {
  minLength: "validation.errors.too-short",
  maxLength: "validation.errors.too-long",
  min: "validation.errors.out-of-range",
  max: "validation.errors.out-of-range",
  exclusiveMin: "validation.errors.out-of-range",
  exclusiveMax: "validation.errors.out-of-range",
  multipleOf: "validation.errors.out-of-range",
};

type ConstraintIssue = Pick<ValidationIssue, "path" | "constraint" | "value">;

// The param a constraint's limit is passed on as (`maxLength: 100` is
// `{ max: 100 }`), the names the other issues of the app already use.
const limitParams: Record<string, "min" | "max"> = {
  minLength: "min",
  maxLength: "max",
  min: "min",
  max: "max",
};

// The params of `too-short` (`min`), `too-long` (`max`) and `out-of-range`:
// there, `bound` says which limit the text names (`min`, `max`, `both` for a
// rule that gives the two limits at once, or `other` when the constraint has
// no plain number to show: an exclusive bound, a `multipleOf`, a limit that is
// not a number). One refused constraint carries a single limit, so `min` and
// `max` are set apart. A limit that is a string (the `ConstraintValue` allows
// it) is passed as its text for `too-short` / `too-long`.
const limitOf = (issue: ConstraintIssue): { params: Params } => {
  const name = issue.constraint && limitParams[issue.constraint];
  const code = issue.constraint && constraintCodes[issue.constraint];
  const value = issue.value;
  if (code === "validation.errors.out-of-range") {
    return {
      params:
        name && typeof value === "number"
          ? { bound: name, [name]: value }
          : { bound: "other" },
    };
  }
  return {
    params:
      name && value !== undefined
        ? { [name]: typeof value === "number" ? value : String(value) }
        : {},
  };
};

// The issues of a @constraint refusal (BAD_USER_INPUT), as the resolver threw
// it or as graphql-js wrapped it with the field's location.
function constraintIssues(error: GraphQLError): ConstraintIssue[] | undefined {
  const source =
    error.extensions["code"] === "BAD_USER_INPUT" ? error : error.originalError;
  if (!(source instanceof GraphQLError)) return undefined;
  if (source.extensions["code"] !== "BAD_USER_INPUT") return undefined;
  const issues = source.extensions["issues"];
  return Array.isArray(issues) ? (issues as ConstraintIssue[]) : undefined;
}

// The variable a request-level coercion error is about. graphql-js raises it
// from `getVariableValues`, before any resolver runs: it has no `path`, and its
// `nodes` hold the variable's definition. Its `extensions.code` is absent, or
// `INVALID_SCALAR` when a scalar of @softistx/graphql-scalars refused the value
// (whose `scalar` and `reason` could name the cause; the issue stays the
// generic `invalid`). Found by that structure, never by its English message.
// (The nested path inside the variable, `filter.from`, is only in the message,
// so the issue names the variable.)
function coercedVariable(error: GraphQLError): string | undefined {
  const code = error.extensions["code"];
  // graxia stamps `BAD_USER_INPUT` on a coercion error that has no code of its
  // own; a @constraint refusal has a path or its own `issues`.
  const coerced =
    code === undefined ||
    code === "INVALID_SCALAR" ||
    code === "BAD_USER_INPUT";
  if (error.path?.length || !coerced || error.extensions["issues"]) {
    return undefined;
  }
  const node = error.nodes?.[0];
  return node?.kind === Kind.VARIABLE_DEFINITION
    ? node.variable.name.value
    : undefined;
}

export const locationOf = (error: GraphQLError): GraphQLErrorOptions => ({
  nodes: error.nodes ?? null,
  source: error.source ?? null,
  positions: error.positions ?? null,
  path: error.path ?? null,
});

// The app's shape of an invalid input (`invalidInput`) for a @constraint
// refusal, at the field's location, and for a variable that cannot be coerced
// (an unparsable value, an unknown input field, a missing required one); any
// other error as it is.
export function reshaped(error: GraphQLError): GraphQLError {
  const variable = coercedVariable(error);
  if (variable !== undefined) {
    return invalidInput(
      [{ path: variable, code: "validation.errors.invalid" }],
      locationOf(error),
    );
  }
  const issues = constraintIssues(error);
  if (!issues) return error;
  return invalidInput(
    issues.map((issue) => ({
      path: inputPath(issue.path),
      code:
        (issue.constraint && constraintCodes[issue.constraint]) ||
        "validation.errors.invalid",
      ...limitOf(issue),
    })),
    locationOf(error),
  );
}

// The error a resolver's janus outage becomes: `auth.errors.unavailable`, at

import { invalidInputError, type Translate } from "@nxgt/graphql-validation";
import type { GraphQLError, GraphQLErrorOptions } from "graphql";
import { i18n } from "../../../i18n";
import type { ErrorCode } from "../../../i18n/codes";
import type { Params } from "../../../i18n/params";

// One refused field of an input: `path` is relative to the input ("name",
// "person.firstName"), `code` an error code, `params` the values its message
// interpolates, passed on to clients.
export interface FieldIssue {
  path: string;
  code: ErrorCode;
  params?: Params;
}

// The request's language, for the builders of @nxgt/graphql-validation.
const translate: Translate = (code, params) =>
  i18n.t(code as ErrorCode, params);

// An input refused as a whole, with every field that refused it: one error
// whatever the module, `validation.errors.invalid-input`, status 400, and
// `extensions.fields: [{ path, code, message, params? }]`, each message
// translated (@nxgt/graphql-validation's `invalidInputError`).
export const invalidInput = (
  issues: FieldIssue[],
  options: GraphQLErrorOptions = {},
): GraphQLError => invalidInputError(issues, { ...options, translate });

// An input refused, with every field that refused it.
export const invalid = (issues: FieldIssue[]) => invalidInput(issues);

// A non-nullable field an update gives as null: it cannot be cleared.
export function required<T extends object>(
  input: T,
  keys: readonly (keyof T & string)[],
): FieldIssue[] {
  return keys
    .filter((key) => input[key] === null)
    .map((path) => ({ path, code: "validation.errors.required" }));
}

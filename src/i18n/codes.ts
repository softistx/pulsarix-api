import { codesOf } from "@alxia/modules";
import { modules } from "../modules/registry";
import { defineCodes } from "./define-codes";

// Who is asking: shared by every module, so declared here. A module declares
// its own codes in `<name>.errors.ts` and lists them in its manifest (`codes`).
export const auth = defineCodes("auth", [
  "client-header-required",
  "unauthenticated",
  "forbidden",
  "unavailable",
  "invalid-credentials",
  "invalid-token",
  "too-many-attempts",
  "exhausted",
  "step-up-required",
  "invalid-code",
  "second-factor-active",
  "second-factor-not-enrolled",
  "second-factor-required",
  "email-unverified",
]);

// Which organisation a request is about: the header, the registry, the slug.
// @alxia/tenancy fixes these three codes, American spelling included.
export const tenancy = defineCodes("tenancy", [
  "organization-required",
  "unknown-organization",
  "slug-taken",
]);

// An input refused: the whole (`invalid-input`) and each field's reason, which
// every module shares, then the limits of a request.
export const validation = defineCodes("validation", [
  "invalid-input",
  "required",
  "invalid",
  "too-short",
  "too-long",
  "out-of-range",
]);

// The inventory at run time: the shared codes, then every module's.
export const errorCodes = [
  ...auth,
  ...tenancy,
  ...validation,
  ...codesOf(modules),
] as readonly string[];

type Shared =
  | (typeof auth)[number]
  | (typeof tenancy)[number]
  | (typeof validation)[number];

// A module's codes are strings in its manifest, so `ErrorCode` stays the shared
// ones plus any `<module>.errors.<slug>`.
export type ErrorCode = Shared | `${string}.errors.${string}`;

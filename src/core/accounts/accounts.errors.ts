import { JanusError } from "@softistx/janus";
import { GraphQLError } from "graphql";
import { i18n } from "../../i18n";
import { fail, invalid, retryParams } from "../shared/errors";

// The module's refusals (CONTEXT.md lists their codes), and how janus's
// errors become them. A code says what the client can act on, never which of
// janus's reasons it was: an unknown e-mail, a deactivated account and a wrong
// password are one `auth.errors.invalid-credentials`.
export const invalidCredentials = () =>
  fail("auth.errors.invalid-credentials", { status: 401 });

// A second factor is set up after the e-mail is proved: proving it later (a
// link) would drop the factor. 403, until the account signs in by a link.
export const emailUnverified = () =>
  fail("auth.errors.email-unverified", { status: 403 });

export const invalidToken = () =>
  fail("auth.errors.invalid-token", { status: 400 });

// Too many tries, or too many mails: 429 `auth.errors.too-many-attempts`, with
// `retryAfter` (seconds) and `minutes` (rounded up) in `extensions` and
// `extensions.params`.
export function tooManyAttempts(retryAfter: number) {
  const params = retryParams(retryAfter);
  return new GraphQLError(i18n.t("auth.errors.too-many-attempts", params), {
    extensions: {
      code: "auth.errors.too-many-attempts",
      params,
      http: { status: 429 },
      ...params,
    },
  });
}

// A wrong code of the second factor or of a step-up, with the tries left when
// janus counts them.
export const invalidCode = (attemptsLeft?: number) =>
  fail("auth.errors.invalid-code", {
    status: 400,
    ...(attemptsLeft !== undefined && { params: { attemptsLeft } }),
  });

// janus's error as the API answers it, or undefined for one it does not
// answer (a wiring mistake, which Yoga masks as a 500). STORE_FAILED is left
// to the `apiErrors` plugin (src/core/shared/errors): 503.
export function fromJanus(error: JanusError): GraphQLError | undefined {
  switch (error.code) {
    case "CREDENTIALS_INVALID":
      return error.retryAfter !== undefined
        ? tooManyAttempts(error.retryAfter)
        : invalidCredentials();
    // Mail requests past the window's limit: nothing was issued, the last
    // link sent still works.
    case "MAIL_THROTTLED":
      return tooManyAttempts(error.retryAfter ?? 1);
    case "CODE_INVALID":
      return invalidCode(error.attemptsLeft);
    case "TOKEN_UNKNOWN":
    case "TOKEN_SPENT":
    case "TOKEN_EXPIRED":
    case "TOKEN_STALE":
    case "VERSION_CONFLICT":
      return invalidToken();
    case "SECOND_FACTOR_ACTIVE":
      return fail("auth.errors.second-factor-active", { status: 409 });
    case "SECOND_FACTOR_NOT_ENROLLED":
      return fail("auth.errors.second-factor-not-enrolled", { status: 409 });
    case "PASSWORD_TOO_SHORT":
      return invalid([
        {
          path: "password",
          code: "validation.errors.too-short",
          // janus reports the policy; 8 is its default.
          params: { min: error.minLength ?? 8 },
        },
      ]);
    case "USER_INACTIVE":
    case "NOT_FOUND":
      return fail("auth.errors.forbidden", { status: 403 });
    default:
      return undefined;
  }
}

// Runs a call to janus, its refusals as the API says them.
export async function authCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof JanusError) throw fromJanus(error) ?? error;
    throw error;
  }
}

// A call on a sign-in path: an unknown or a deactivated account answers as a
// wrong password does, so no answer tells whether the account exists.
export function signInCall<T>(call: () => Promise<T>): Promise<T> {
  return authCall(async () => {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof JanusError &&
        (error.code === "USER_INACTIVE" || error.code === "NOT_FOUND")
      ) {
        throw invalidCredentials();
      }
      throw error;
    }
  });
}

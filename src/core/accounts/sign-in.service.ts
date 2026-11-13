import { JanusError } from "@softistx/janus";
import { isLocale, type Locale } from "../../i18n/locale";
import type { Auth } from "../auth";
import { invalid, unavailable } from "../shared/errors";
import { authCall, signInCall } from "./accounts.errors";
import { sessionOf, signedIn } from "./accounts.utils";

// The account's stored language when it has one, else the request's.
const accountLocale = (
  user: { locale?: string | null | undefined },
  fallback: Locale,
): Locale => (isLocale(user.locale) ? user.locale : fallback);

// The sign-in flows, over janus: sign-up, a password, the second factor's
// code, a link sent by e-mail, a forgotten password. Each janus refusal leaves
// as the API's code (accounts.errors.ts). janus throttles the passwords of one
// e-mail and the mails of one address itself; the per-address limit of sign-up
// is the resolver's (src/core/shared/throttle.ts).
export class SignInService {
  constructor(
    private readonly auth: Auth,
    private readonly request: Request,
    private readonly locale: Locale,
  ) {}

  // Whether sign-in by link is on (env PULSARIX_MAGIC_LINK).
  get magicLink() {
    return this.auth.magicLink;
  }

  private get users() {
    return this.auth.accounts.user;
  }

  // Makes the account and signs it in. Its e-mail is not proved: a link or an
  // invitation proves it. An address that is taken is an `invalid` issue on
  // `email`, which tells a visitor that the address has an account: the price
  // of a sign-up form that does not mail first.
  async signUp(input: { email: string; password: string; name: string }) {
    try {
      const opened = await this.users.signUp({
        email: input.email,
        name: input.name.trim(),
        locale: this.locale,
        password: input.password,
      });
      return {
        status: "SIGNED_IN" as const,
        session: sessionOf(opened),
        challenge: null,
      };
    } catch (error) {
      if (
        error instanceof JanusError &&
        (error.code === "LOGIN_TAKEN" || error.code === "USER_INVALID")
      ) {
        throw invalid([{ path: "email", code: "validation.errors.invalid" }]);
      }
      return authCall(() => Promise.reject(error));
    }
  }

  signIn(input: { email: string; password: string }) {
    return signInCall(async () => signedIn(await this.users.signIn(input)));
  }

  // The six-digit code of the app, for the challenge a sign-in answered.
  confirmSecondFactor(challenge: string, code: string) {
    return authCall(async () =>
      signedIn(await this.users.secondFactor.confirm(challenge, code)),
    );
  }

  // A recovery code in place of the app's code; it is spent.
  recoverSecondFactor(challenge: string, recoveryCode: string) {
    return authCall(async () =>
      signedIn(await this.users.secondFactor.recover(challenge, recoveryCode)),
    );
  }

  // Sends a sign-in link. The address is counted in the request (`prepare`:
  // validated, counted, no lookup, the same store calls for any address), so
  // the mail throttle answers 429 for a known and an unknown address alike.
  // The lookup and the mail run in the background, so neither the answer nor
  // its time tells whether the account exists. The mail is written in the
  // account's language, else the request's.
  // With the flag off (env PULSARIX_MAGIC_LINK) it answers true and does
  // nothing, as for an unknown address.
  async requestMagicLink(email: string) {
    if (!this.auth.magicLink) return true;
    const locale = this.locale;
    const prepared = await authCall(() => this.users.magicLink.prepare(email));
    this.auth.background.run("a sign-in link", async () => {
      const issued = await prepared.send();
      if (issued) {
        await this.auth.mail.magicLink(issued, {
          locale: accountLocale(issued.user, locale),
        });
      }
    });
    return true;
  }

  // Refused 503 `auth.errors.unavailable` with the flag off.
  confirmMagicLink(token: string) {
    if (!this.auth.magicLink) throw unavailable();
    return signInCall(async () =>
      signedIn(await this.users.magicLink.confirm(token)),
    );
  }

  // Sends a reset link; true either way, throttled as above.
  async requestPasswordReset(email: string) {
    const locale = this.locale;
    const prepared = await authCall(() =>
      this.users.resetPassword.prepare(email),
    );
    this.auth.background.run("a password-reset link", async () => {
      const issued = await prepared.send();
      if (issued) {
        await this.auth.mail.resetPassword(issued, {
          name: issued.user.name,
          locale: accountLocale(issued.user, locale),
        });
      }
    });
    return true;
  }

  // janus signs the account out everywhere: the visitor signs in again.
  resetPassword(token: string, password: string) {
    return authCall(async () => {
      await this.users.resetPassword.confirm(token, password);
      return true;
    });
  }

  signOut() {
    return this.auth.accounts.signOut(this.request);
  }
}

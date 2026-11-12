import { JanusError } from "@softistx/janus";
import type { Locale } from "../../i18n/locale";
import type { Auth } from "../auth";
import { requireFresh } from "../auth/fresh";
import { type Viewer, viewerOf } from "../auth/viewer";
import { invalid, required } from "../shared/errors";
import { authCall } from "./accounts.errors";

// What the signed-in account does to itself: its name and language, its
// password, its second factor, a step-up. Built for the request's viewer (a
// guard already refused an anonymous one), it touches that account only.
export class ViewerService {
  constructor(
    private readonly auth: Auth,
    private readonly viewer: Viewer,
    private readonly request: Request,
    private readonly locale: Locale,
  ) {}

  private get users() {
    return this.auth.accounts.user;
  }

  // Name and language only, whatever else the account holds (e-mail, roles).
  // A field left out keeps its value; a null one is refused.
  async update(input: { name?: string | null; language?: "EN" | "FR" | null }) {
    const name = input.name?.trim();
    const issues = [
      ...required(input, ["name", "language"]),
      ...(name === ""
        ? [{ path: "name", code: "validation.errors.required" as const }]
        : []),
    ];
    if (issues.length > 0) throw invalid(issues);
    const patch: { name?: string; locale?: "en" | "fr" } = {};
    if (name) patch.name = name;
    if (input.language != null) {
      patch.locale = input.language === "EN" ? "en" : "fr";
    }
    if (Object.keys(patch).length === 0) return this.viewer;
    const user = await authCall(() => this.users.update(this.viewer.id, patch));
    return {
      ...viewerOf(user),
      sessionExpiresAt: this.viewer.sessionExpiresAt,
      authenticatedAt: this.viewer.authenticatedAt,
      sessionId: this.viewer.sessionId,
    };
  }

  // janus checks the current password and the policy (the same minimum as a
  // reset) and counts the try in the account's sign-in limit. It then signs the
  // account out of its other sessions; the request's own stays. A wrong
  // current password answers 400 (never 401: a client treats a 401 as an
  // expired session); past the sign-in limit, 429 as a sign-in does.
  async changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }) {
    await authCall(async () => {
      try {
        await this.users.changePassword(this.viewer.id, {
          current: input.currentPassword,
          next: input.newPassword,
        });
      } catch (error) {
        if (error instanceof JanusError) {
          // The refusals name the fields of this input.
          if (error.code === "PASSWORD_TOO_SHORT") {
            throw invalid([
              {
                path: "newPassword",
                code: "validation.errors.too-short",
                params: { min: error.minLength ?? 8 },
              },
            ]);
          }
          if (
            error.code === "CREDENTIALS_INVALID" &&
            error.retryAfter === undefined
          ) {
            throw invalid([
              { path: "currentPassword", code: "validation.errors.invalid" },
            ]);
          }
        }
        throw error;
      }
    });
    await this.auth.accounts.signOutEverywhere(this.viewer.id, {
      ...(this.viewer.sessionId && { except: this.viewer.sessionId }),
      issuedBefore: this.auth.clock.now(),
    });
    return true;
  }

  // Starts a TOTP second factor: the secret and the otpauth URI to render as a
  // QR code, answered once. A waiting secret is replaced; an active factor is
  // refused (disable it first). 403 `auth.errors.email-unverified` while the
  // e-mail is not proved (janus's EMAIL_UNVERIFIED).
  enrollSecondFactor() {
    requireFresh(this.viewer, this.auth.clock);
    return authCall(() => this.users.secondFactor.enroll(this.viewer.id));
  }

  // The first code the app shows: the factor is active from now on, and the
  // ten recovery codes are answered, once.
  activateSecondFactor(code: string) {
    return authCall(async () => {
      const { recoveryCodes } = await this.users.secondFactor.activate(
        this.viewer.id,
        code,
      );
      return { codes: [...recoveryCodes] };
    });
  }

  // Removes the factor and its recovery codes, for a session that proved who
  // it is recently.
  disableSecondFactor() {
    requireFresh(this.viewer, this.auth.clock);
    return authCall(async () => {
      await this.users.secondFactor.disable(this.viewer.id);
      return true;
    });
  }

  // A confirmation for a sensitive action: the app's code when a second factor
  // is active, else a code mailed to the account.
  requestStepUp() {
    return authCall(async () => {
      const issued = await this.users.stepUp.request(this.viewer.id);
      if (issued.via === "email") {
        await this.auth.mail.stepUp(issued, {
          name: this.viewer.name,
          locale: this.viewer.locale ?? this.locale,
        });
      }
      return {
        challenge: issued.challenge,
        via: issued.via === "email" ? ("EMAIL" as const) : ("APP" as const),
        expiresAt: issued.expiresAt,
      };
    });
  }

  // Stamps the request's session as freshly confirmed.
  confirmStepUp(challenge: string, code: string) {
    return authCall(async () => {
      await this.users.stepUp.confirm(this.request, challenge, code);
      return true;
    });
  }
}

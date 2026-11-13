import type { Locale } from "../../i18n/locale";
import type { Auth } from "./auth";

// Who sends the request: the signed-in janus account, or null. `id` is the
// account's id, a UUIDv7, which every write stamps as its actor.
export interface Viewer {
  id: string;
  email: string;
  name: string;
  // The account's preferred language; null or absent when it never did.
  locale?: Locale | null;
  // Whether the account's TOTP second factor is active.
  hasSecondFactor: boolean;
  // Whether the account's e-mail is proved (a link or an invitation proves it).
  // A second factor is set up only after it: proving an e-mail for the first
  // time drops the factor (janus).
  emailVerified: boolean;
  // When the request's session ends; null when no session was read (a fake
  // in a spec).
  sessionExpiresAt: Date | null;
  // When the request's session last proved who it is (sign-in, or a step-up);
  // null when no session was read. Sensitive actions ask it to be recent.
  authenticatedAt: Date | null;
  // The request's session id; null when no session was read.
  sessionId: string | null;
}

// The viewer as the GraphQL type `Viewer` is mapped to (codegen.ts): the
// generated types already declare a `Viewer`.
export type ViewerModel = Viewer;

// A janus account as the API's viewer, with the session it signed in with.
export const viewerOf = (
  user: {
    id: string;
    email: string;
    name: string;
    locale?: Locale | undefined;
    hasSecondFactor?: boolean;
    emailVerified?: boolean;
  },
  session?: { id?: string; expiresAt: Date; authenticatedAt?: Date },
): Viewer => ({
  id: user.id,
  email: user.email,
  name: user.name,
  locale: user.locale ?? null,
  hasSecondFactor: user.hasSecondFactor ?? false,
  emailVerified: user.emailVerified ?? false,
  sessionExpiresAt: session?.expiresAt ?? null,
  authenticatedAt: session?.authenticatedAt ?? null,
  sessionId: session?.id ?? null,
});

// How the request's viewer is read: null for an anonymous request. A store
// that cannot answer rejects, and the request is answered 503.
export type ResolveViewer = (request: Request) => Promise<Viewer | null>;

export const anonymous: ResolveViewer = async () => null;

// The viewer janus authenticates: `Authorization: Bearer`, then
// `X-Session-Token`, then the session cookie, the first one present wins.
// pulsarix-ui's BFF sends the bearer.
export function janusViewer(auth: Pick<Auth, "accounts">): ResolveViewer {
  return async (request) => {
    const current = await auth.accounts.authenticate(request);
    return current && viewerOf(current.user, current.session);
  };
}

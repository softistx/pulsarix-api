// The links the mails carry, to pages of pulsarix-ui that spend nothing: each
// posts its token back to the API from a button (a mail scanner follows a
// link, so a GET never consumes it). The paths are fixed, CONTEXT.md "Mail
// links"; the UI never renames them alone. `verifyEmail` is sent by
// `requestEmailVerification`; `secureAccount` is required by janus-mail's
// wiring, but no flow of pulsarix sends it.
export function mailLinks(uiOrigin: string) {
  const at = (path: string, token?: string) =>
    token === undefined
      ? `${uiOrigin}${path}`
      : `${uiOrigin}${path}?token=${encodeURIComponent(token)}`;
  return {
    invitation: (token: string) => at("/invitations/accept", token),
    magicLink: (token: string) => at("/auth/magic-link", token),
    resetPassword: (token: string) => at("/auth/reset-password", token),
    verifyEmail: (token: string) => at("/auth/verify-email", token),
    secureAccount: () => at("/account/security"),
    getStarted: () => at("/"),
  };
}

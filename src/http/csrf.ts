import { definePlugin } from "@softistx/graxia";
import { fail } from "../core/shared/errors";

// The header every /graphql request carries, any non-empty value (the
// client's name: "pulsarix-ui", "apollo-sandbox"…). A browser sends a custom
// header only after a CORS preflight, which a page of another origin does not
// pass, and a form or a plain <img> GET cannot send one: no cross-site
// request reaches a resolver, cookie or not.
export const clientHeader = "x-pulsarix-client";

// A graxia plugin (src/app.ts): an operation without the header is refused
// before it is parsed, 403 `auth.errors.client-header-required`. graxia's own
// CSRF check (`CSRF_HEADER_REQUIRED`) lets a JSON POST through; this one checks
// every operation. It runs in `onParams`, not `onRequest`, so the IDE's GET
// page is not blocked, and refuses with `respond`, never a throw (a throw is a
// 500).
export const requireClientHeader = definePlugin({
  name: "pulsarix-client-header",
  onParams: ({ request, respond }) => {
    if (request.headers.get(clientHeader)?.trim()) return;
    const error = fail("auth.errors.client-header-required", {
      params: { header: clientHeader },
      status: 403,
    });
    respond(Response.json({ errors: [error.toJSON()] }, { status: 403 }));
  },
});

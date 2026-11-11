import type { Plugin } from "graphql-yoga";
import { fail } from "../core/shared/errors";

// The header every /graphql request carries, any non-empty value (the
// client's name: "pulsarix-ui", "apollo-sandbox"…). A browser sends a custom
// header only after a CORS preflight, which a page of another origin does not
// pass, and a form or a plain <img> GET cannot send one: no cross-site
// request reaches a resolver, cookie or not.
export const clientHeader = "x-pulsarix-client";

// A Yoga plugin (src/app.ts): a request without the header is refused before
// it is parsed, 403 `auth.errors.client-header-required`. Yoga's
// `useCSRFPrevention` checks only the requests a browser does not preflight;
// this one checks every request.
export const requireClientHeader: Plugin = {
  onRequestParse({ request }) {
    if (request.headers.get(clientHeader)?.trim()) return;
    throw fail("auth.errors.client-header-required", {
      params: { header: clientHeader },
      status: 403,
    });
  },
};

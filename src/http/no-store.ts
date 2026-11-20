import { definePlugin } from "@graxia/core";

// A graxia plugin (src/app.ts): every GraphQL response carries
// `Cache-Control: no-store`. The answers hold a session token and account data;
// janus's guide asks that they are never cached by a browser or a proxy. It
// goes first in the list: `respond` skips the plugins after it, so the
// refusals of the plugins below keep the header. A body declared over the limit
// gets core's 413 without this header: that answer holds nothing to cache.
export const noStore = definePlugin({
  name: "pulsarix-no-store",
  onRequest: ({ responseHeaders }) => {
    responseHeaders.set("cache-control", "no-store");
  },
});

import {
  type ChronixLinkFactory,
  type ChronixLinkOptions,
  createChronixLinkClient,
} from "./chronix";

// The factory the app runs with: the HTTP client; a spec gives its own
// (`createApp({ chronix })`). Kept out of `chronix.ts`, which is removed whole
// when `@softistx/chronix-react/server` replaces the port.
let factory: ChronixLinkFactory = createChronixLinkClient;
export const useChronix = (next: ChronixLinkFactory | undefined) => {
  factory = next ?? createChronixLinkClient;
};
export const chronixClient = (options: ChronixLinkOptions) => factory(options);

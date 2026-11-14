import {
  type ChronixLinkClient,
  type ChronixLinkClientOptions,
  createChronixLinkClient,
} from "@softistx/chronix-react/server";

// What the app builds a client with: the package's HTTP client by default; a
// spec gives its own (`createApp({ chronix })`).
export type ChronixLinkFactory = (
  options: ChronixLinkClientOptions,
) => ChronixLinkClient;

let factory: ChronixLinkFactory = createChronixLinkClient;
export const useChronix = (next: ChronixLinkFactory | undefined) => {
  factory = next ?? createChronixLinkClient;
};
export const chronixClient = (options: ChronixLinkClientOptions) =>
  factory(options);

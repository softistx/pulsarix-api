import { apiErrors } from "../core/shared/errors";
import { requireClientHeader } from "./csrf";
import { noStore } from "./no-store";

// The graxia plugins of /graphql, in order: the header plugin first, since
// `respond` skips the plugins after it.
export const graphqlPlugins = [noStore, requireClientHeader, apiErrors];

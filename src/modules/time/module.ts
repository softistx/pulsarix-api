import { defineModule } from "@alxia/modules";
import { defineCodes } from "../../i18n/define-codes";
import timeTypeDefs from "./time.graphqls" with { type: "text" };
import { timeLinks } from "./time.model";
import { timeResolvers } from "./time.resolver";

// Time tracking through chronix (chronix plan §10): the organisation's link key
// (sealed, never returned), the timer and the manual log on issues, and the time
// spent read from chronix. pulsarix stores no time entry; chronix is the source
// of truth. The estimate is a field of the issue (issues module).
export const timeModule = defineModule({
  name: "time",
  dependsOn: ["access", "organisations", "issues"],
  collections: { timeLinks },
  typeDefs: [timeTypeDefs],
  resolvers: timeResolvers as never,
  permissions: ["time:read", "time:write", "time:manage"],
  defaultGrants: {
    admin: ["time:read", "time:write", "time:manage"],
    member: ["time:read", "time:write"],
    viewer: ["time:read"],
  },
  codes: defineCodes("time", [
    "not-linked",
    "invalid-key",
    "unavailable",
    "forbidden",
    "email-unverified",
    "key-mismatch",
    "project-not-mapped",
    "period-locked",
    "project-archived",
    "project-mapped",
    "archived",
    "catalogue-project-not-found",
    "rate-limited",
  ]),
});

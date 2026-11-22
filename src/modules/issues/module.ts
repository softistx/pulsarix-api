import { defineModule } from "@softistx/alxia-modules";
import { toObjectId } from "@softistx/mongo";
import { defineCodes } from "../../i18n/define-codes";
import { registerLabelRemoval, registerStatusUsage } from "../projects/public";
import issuesTypeDefs from "./issues.graphqls" with { type: "text" };
import { issueCounters, issues } from "./issues.model";
import { issuesResolvers } from "./issues.resolver";
import type { IssuesMongo } from "./issues.types";

// The projects module calls these inside its own transactions; the handle it
// passes is the organisation's database, which holds the issues as well.
const asIssues = (mongo: unknown) => mongo as IssuesMongo;

// A status issues stand on cannot be deleted (409 `status-in-use`).
registerStatusUsage((mongo, statusId) =>
  asIssues(mongo).db.issues.exists({ statusId: toObjectId(statusId) }),
);

// A deleted label leaves the issues that carried it.
registerLabelRemoval(async (mongo, labelId) => {
  const id = toObjectId(labelId);
  await asIssues(mongo).db.issues.updateMany(
    { labelIds: id },
    { $pull: { labelIds: id } },
  );
});

// The issues of the projects, with their gap-free numbers per project.
export const issuesModule = defineModule({
  name: "issues",
  dependsOn: ["access", "organisations", "projects"],
  collections: { issues, issueCounters },
  typeDefs: [issuesTypeDefs],
  resolvers: issuesResolvers as never,
  permissions: ["issue:read", "issue:write", "issue:delete"],
  defaultGrants: {
    admin: ["issue:read", "issue:write", "issue:delete"],
    member: ["issue:read", "issue:write"],
    viewer: ["issue:read"],
  },
  codes: defineCodes("issues", [
    "not-found",
    "parent-cycle",
    "bad-placement",
    "project-archived",
    "parent-not-allowed",
    "parent-type-invalid",
    "parent-required",
    "type-breaks-children",
    "points-off-scale",
    "points-not-allowed",
  ]),
});

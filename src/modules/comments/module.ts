import { defineModule } from "@alxia/modules";
import { toObjectId } from "@softistx/mongo";
import { defineCodes } from "../../i18n/define-codes";
import { registerIssueRemoval } from "../issues/public";
import commentsTypeDefs from "./comments.graphqls" with { type: "text" };
import { comments } from "./comments.model";
import { commentsResolvers } from "./comments.resolver";
import type { CommentsMongo } from "./comments.service";

// A deleted issue takes its comments with it (inside the deleting
// transaction, whose handle also holds the comments).
registerIssueRemoval(async (mongo, issueId) => {
  await (mongo as unknown as CommentsMongo).db.comments.hardDeleteMany({
    issueId: toObjectId(issueId),
  });
});

// The comments on issues, with their mentions resolved to members.
export const commentsModule = defineModule({
  name: "comments",
  dependsOn: ["access", "organisations", "issues"],
  collections: { comments },
  typeDefs: [commentsTypeDefs],
  resolvers: commentsResolvers as never,
  // Anyone who can write an issue comments; `comment:delete` (admin, owner) is
  // what lets one change the comments of others.
  permissions: ["comment:read", "comment:write", "comment:delete"],
  defaultGrants: {
    admin: ["comment:read", "comment:write", "comment:delete"],
    member: ["comment:read", "comment:write"],
    viewer: ["comment:read"],
  },
  codes: defineCodes("comments", [
    "not-found",
    "not-yours",
    "public-author-only",
    "mention-not-member",
  ]),
});

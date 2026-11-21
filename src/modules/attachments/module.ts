import { defineModule } from "@softistx/alxia-modules";
import { toObjectId } from "@softistx/mongo";
import { defineCodes } from "../../i18n/define-codes";
import { registerCommentChange } from "../comments/public";
import { registerIssueChange } from "../issues/public";
import attachmentsTypeDefs from "./attachments.graphqls" with { type: "text" };
import { removeFilesWhere } from "./attachments.integrity";
import { attachments } from "./attachments.model";
import { attachmentsResolvers } from "./attachments.resolver";

// A deleted issue takes its files with it, those of its comments included,
// and a deleted comment its own: the records inside the deleting transaction,
// the bucket objects once it has committed.
registerIssueChange(async (mongo, change) =>
  change.verb === "deleted"
    ? removeFilesWhere(mongo, change.organisationId, {
        issueId: change.issue._id,
      })
    : undefined,
);
registerCommentChange(async (mongo, change) =>
  change.verb === "commentDeleted"
    ? removeFilesWhere(mongo, change.organisationId, {
        ownerId: toObjectId(change.comment.id),
      })
    : undefined,
);

// The files on issues and comments, stored in a private bucket through
// @softistx/alxia-media, with a thumbnail for pictures.
export const attachmentsModule = defineModule({
  name: "attachments",
  dependsOn: ["access", "organisations", "issues", "comments"],
  collections: { attachments },
  typeDefs: [attachmentsTypeDefs],
  resolvers: attachmentsResolvers as never,
  // Anyone who reads an issue reads its files; whoever writes one attaches;
  // `attachment:delete` (admin, owner) removes the files of others.
  permissions: ["attachment:read", "attachment:write", "attachment:delete"],
  defaultGrants: {
    admin: ["attachment:read", "attachment:write", "attachment:delete"],
    member: ["attachment:read", "attachment:write"],
    viewer: ["attachment:read"],
  },
  codes: defineCodes("attachments", [
    "not-found",
    "too-many",
    "too-large",
    "unsupported-type",
    "undecodable",
    "too-small",
    "unavailable",
  ]),
});

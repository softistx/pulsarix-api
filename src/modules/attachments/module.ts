import { defineModule } from "@alxia/modules";
import { toObjectId } from "@softistx/mongo";
import { defineCodes } from "../../i18n/define-codes";
import { registerCommentChange } from "../comments/public";
import { registerIssueChange } from "../issues/public";
import attachmentsTypeDefs from "./attachments.graphqls" with { type: "text" };
import { attachments } from "./attachments.model";
import { attachmentsResolvers } from "./attachments.resolver";
import type { AttachmentsMongo } from "./attachments.service";
import { objectKeys, purge } from "./attachments.storage";

// Deletes the records matching `filter` inside the writing transaction and
// answers the purge of their objects, to run once it has committed.
async function removeWhere(
  mongo: unknown,
  organisationId: string,
  filter:
    | { issueId: ReturnType<typeof toObjectId> }
    | { ownerId: ReturnType<typeof toObjectId> },
) {
  const db = (mongo as AttachmentsMongo).db.attachments;
  const found = await db.findMany({ filter });
  if (found.length === 0) return undefined;
  await db.hardDeleteMany(filter);
  const keys = found.flatMap((file) => objectKeys(organisationId, file));
  return () => purge(keys);
}

// A deleted issue takes its files with it, those of its comments included,
// and a deleted comment its own: the records inside the deleting transaction,
// the bucket objects once it has committed.
registerIssueChange(async (mongo, change) =>
  change.verb === "deleted"
    ? removeWhere(mongo, change.organisationId, {
        issueId: change.issue._id,
      })
    : undefined,
);
registerCommentChange(async (mongo, change) =>
  change.verb === "commentDeleted"
    ? removeWhere(mongo, change.organisationId, {
        ownerId: toObjectId(change.comment.id),
      })
    : undefined,
);

// The files on issues and comments, stored in a private bucket through
// @alxia/media, with a thumbnail for pictures.
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

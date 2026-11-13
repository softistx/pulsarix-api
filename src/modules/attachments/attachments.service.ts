import type { ModuleMongo } from "../../config/db";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import { exhausted, invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { retryWriteConflicts } from "../../core/shared/locked";
import { commentNotFound } from "../comments/public";
import {
  type IssueChange,
  issueChanged,
  issueNotFound,
} from "../issues/public";
import { attachmentNotFound, tooMany } from "./attachments.errors";
import { maxPerOwner } from "./attachments.kinds";
import type { AttachmentDocument, OwnerType } from "./attachments.model";
import { objectKeys, purge } from "./attachments.storage";

export type AttachmentsMongo = ModuleMongo<"attachments">;

// An owner as the upload names it, resolved: the issue the file belongs to
// (the comment's issue for a comment).
export interface Owner {
  ownerType: OwnerType;
  ownerId: string;
  issueId: string;
  // The author of a comment owner.
  authorId?: string;
}

export interface NewAttachment {
  owner: Owner;
  fileName: string;
  mime: string;
  size: number;
  storageKey: string;
  previewKey: string | null;
}

// A file name as stored: the last path segment, control characters out.
export function cleanFileName(raw: string | null): string | null {
  // Control characters and the invisible direction marks that disguise an
  // extension (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF) are dropped.
  const name = (raw ?? "").replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    "",
  );
  const last = name.split(/[\\/]/).pop()?.trim() ?? "";
  return last && last !== "." && last !== ".."
    ? Array.from(last).slice(0, 200).join("")
    : null;
}

// The owner an upload names (`ownerType`, `ownerId`): it must exist, and a
// comment's files are added by its author or a moderator.
export async function resolveOwner(
  mongo: AttachmentsMongo,
  ownerType: string | null,
  ownerId: string | null,
): Promise<Owner> {
  if (ownerType !== "issue" && ownerType !== "comment") {
    throw invalid([{ path: "ownerType", code: "validation.errors.invalid" }]);
  }
  const id = idOrInvalid(ownerId ?? "", "ownerId");
  if (ownerType === "issue") {
    if (!(await mongo.db.issues.exists({ _id: id }))) throw issueNotFound();
    return { ownerType, ownerId: id.toHexString(), issueId: id.toHexString() };
  }
  const comment = await mongo.db.comments.findById(id);
  if (!comment) throw commentNotFound();
  return {
    ownerType,
    ownerId: comment.id,
    issueId: comment.issueId.toHexString(),
    authorId: comment.authorId,
  };
}

// `moderator`: the viewer may delete files they did not upload (the admin and
// the owner, who hold `attachment:delete`).
export class AttachmentsService {
  constructor(
    private readonly mongo: AttachmentsMongo,
    private readonly viewerId: string,
    private readonly moderator: boolean,
    private readonly organisationId: string,
  ) {}

  // The files of an issue or a comment, oldest first.
  async list(
    ownerType: OwnerType,
    ownerId: string,
  ): Promise<AttachmentDocument[]> {
    const owner = await resolveOwner(this.mongo, ownerType, ownerId);
    return this.mongo.db.attachments.findMany({
      filter: {
        ownerType: owner.ownerType,
        ownerId: idOrInvalid(owner.ownerId, "ownerId"),
      },
      sort: { _id: 1 },
    });
  }

  // Refuses an owner that already carries `maxPerOwner` files.
  async ensureRoom(owner: Owner): Promise<void> {
    const count = await this.mongo.db.attachments.count({
      ownerType: owner.ownerType,
      ownerId: idOrInvalid(owner.ownerId, "ownerId"),
    });
    if (count >= maxPerOwner) throw tooMany(maxPerOwner);
  }

  // Runs `work` in a transaction. What it reports is journalled on the issue
  // inside it, as an `updated` change of the field `attachment` (the file name
  // as `to` for an upload, as `from` for a delete), so the activity feed and
  // the watchers' notifications follow the issue's other changes. The live
  // events go out once it has committed.
  private async journalled<T>(
    issueId: string,
    work: (
      tx: AttachmentsMongo,
      changed: (from: string | null, to: string | null) => Promise<void>,
    ) => Promise<T>,
    // An upload needs its issue (else the write rolls back and the route
    // removes the stored file); a delete may find it gone with it.
    issueRequired: boolean,
  ): Promise<T> {
    let later: AfterCommit[] = [];
    const result = await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          later = [];
          const changed = async (from: string | null, to: string | null) => {
            const issue = await tx.db.issues.findById(
              idOrInvalid(issueId, "issueId"),
            );
            if (!issue) {
              // The issue is going in the same transaction: its deletion is journalled.
              if (issueRequired) throw issueNotFound();
              return;
            }
            const change: IssueChange = {
              verb: "updated",
              issue,
              changes: [{ field: "attachment", from, to }],
              actorId: this.viewerId,
              organisationId: this.organisationId,
            };
            // The transaction's mongo holds the issues and activity collections too.
            later.push(
              ...(await issueChanged(
                tx as unknown as ModuleMongo<"issues">,
                change,
              )),
            );
          };
          return work(tx as AttachmentsMongo, changed);
        }),
      exhausted,
    );
    await runAfterCommit(later);
    return result;
  }

  // The files of an issue and of all its comments, oldest first.
  async listForIssue(issueId: string): Promise<AttachmentDocument[]> {
    const id = idOrInvalid(issueId, "issueId");
    if (!(await this.mongo.db.issues.exists({ _id: id })))
      throw issueNotFound();
    return this.mongo.db.attachments.findMany({
      filter: { issueId: id },
      sort: { _id: 1 },
    });
  }

  // Records a file the upload route has just stored.
  async record(file: NewAttachment): Promise<AttachmentDocument> {
    await this.ensureRoom(file.owner);
    return this.journalled(
      file.owner.issueId,
      async (tx, changed) => {
        const created = await tx.db.attachments.create({
          ownerType: file.owner.ownerType,
          ownerId: idOrInvalid(file.owner.ownerId, "ownerId"),
          issueId: idOrInvalid(file.owner.issueId, "issueId"),
          fileName: file.fileName,
          mime: file.mime,
          size: file.size,
          storageKey: file.storageKey,
          previewKey: file.previewKey,
          uploadedBy: this.viewerId,
        });
        await changed(null, created.fileName);
        return created;
      },
      true,
    );
  }

  // Answers the attachment's id. Its uploader or a moderator deletes it; the
  // objects leave the bucket once the record is gone.
  async delete(id: string): Promise<string> {
    const found = await this.mongo.db.attachments.findById(
      idOrInvalid(id, "id"),
    );
    if (!found) throw attachmentNotFound();
    if (found.uploadedBy !== this.viewerId && !this.moderator) {
      throw attachmentNotFound();
    }
    await this.journalled(
      found.issueId.toHexString(),
      async (tx, changed) => {
        await tx.db.attachments.hardDelete(found._id);
        await changed(found.fileName, null);
      },
      false,
    );
    await purge(objectKeys(this.organisationId, found));
    return found.id;
  }
}

import type { ModuleMongo } from "../../config/db";
import { invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { commentNotFound } from "../comments/comments.errors";
import { issueNotFound } from "../issues/issues.errors";
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

  // Records a file the upload route has just stored.
  async record(file: NewAttachment): Promise<AttachmentDocument> {
    await this.ensureRoom(file.owner);
    return this.mongo.db.attachments.create({
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
    await this.mongo.db.attachments.hardDelete(found._id);
    await purge(objectKeys(this.organisationId, found));
    return found.id;
  }
}

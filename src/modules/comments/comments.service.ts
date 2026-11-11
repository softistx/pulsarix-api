import type { ObjectId } from "mongodb";
import type { ModuleMongo } from "../../config/db";
import {
  type AfterCommit,
  runAfterCommit,
} from "../../core/shared/after-commit";
import { exhausted, invalid } from "../../core/shared/errors";
import { idOrInvalid } from "../../core/shared/ids";
import { retryWriteConflicts } from "../../core/shared/locked";
import { issueNotFound } from "../issues/issues.errors";
import {
  commentNotFound,
  commentNotYours,
  mentionNotMember,
} from "./comments.errors";
import type { CommentDocument } from "./comments.model";
import { type CommentChange, commentChanged } from "./comments.usage";
import { mentionedIds } from "./mentions";

export type CommentsMongo = ModuleMongo<"comments">;

// Whether an account is a member of the organisation.
export type IsMember = (accountId: string) => Promise<boolean>;

export interface CommentInput {
  body: string;
  public?: boolean | null;
}

export interface EditCommentInput {
  body?: string | null;
  public?: boolean | null;
}

export const MAX_PAGE = 100;

// Distinct mentions in one body: each costs a membership lookup.
export const MAX_MENTIONS = 50;

export interface CommentPage {
  nodes: CommentDocument[];
  endCursor: string | null;
  hasNextPage: boolean;
}

// `moderator`: the viewer may change comments they did not write (the admin
// and the owner, who hold `comment:delete`).
export class CommentsService {
  constructor(
    private readonly mongo: CommentsMongo,
    private readonly isMember: IsMember,
    private readonly viewerId: string,
    private readonly moderator: boolean,
    private readonly organisationId: string,
  ) {}

  // Runs `work` in a transaction; what `changed` reports is written inside it
  // by the registered handlers (the activity journal), and their live events
  // go out once it has committed.
  private async write<T>(
    work: (
      tx: CommentsMongo,
      changed: (
        verb: CommentChange["verb"],
        comment: CommentDocument,
      ) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    let later: AfterCommit[] = [];
    const result = await retryWriteConflicts(
      () =>
        this.mongo.transaction(async (tx) => {
          later = [];
          return work(tx as CommentsMongo, async (verb, comment) => {
            later.push(
              ...(await commentChanged(tx as CommentsMongo, {
                verb,
                comment,
                actorId: this.viewerId,
                organisationId: this.organisationId,
              })),
            );
          });
        }),
      exhausted,
    );
    await runAfterCommit(later);
    return result;
  }

  private async issue(issueId: string): Promise<ObjectId> {
    const id = idOrInvalid(issueId, "issueId");
    if (!(await this.mongo.db.issues.exists({ _id: id }))) {
      throw issueNotFound();
    }
    return id;
  }

  // A comment's body, trimmed, and the members its markers name; refuses a
  // marker whose id is no member (the ids are the client's claim).
  private async resolve(body: string) {
    const text = body.trim();
    if (!text) {
      throw invalid([{ path: "body", code: "validation.errors.required" }]);
    }
    const ids = mentionedIds(text);
    if (ids.length > MAX_MENTIONS) {
      throw invalid([{ path: "body", code: "validation.errors.out-of-range" }]);
    }
    const known = await Promise.all(ids.map((id) => this.isMember(id)));
    const strangers = ids.filter((_, i) => !known[i]);
    if (strangers.length > 0) throw mentionNotMember(strangers);
    return { body: text, mentionIds: ids };
  }

  async list(
    issueId: string,
    first: number | null | undefined,
    after?: string | null,
  ): Promise<CommentPage> {
    const limit = first ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw invalid([
        { path: "first", code: "validation.errors.out-of-range" },
      ]);
    }
    const issue = await this.issue(issueId);
    const cursor = after ? idOrInvalid(after, "after") : null;
    const found = await this.mongo.db.comments.findMany({
      filter: { issueId: issue, ...(cursor && { _id: { $gt: cursor } }) },
      sort: { _id: 1 },
      limit: limit + 1,
    });
    const nodes = found.slice(0, limit);
    const last = nodes.at(-1);
    const hasNextPage = found.length > limit;
    return {
      nodes,
      endCursor: hasNextPage && last ? last.id : null,
      hasNextPage,
    };
  }

  async add(issueId: string, input: CommentInput): Promise<CommentDocument> {
    const issue = await this.issue(issueId);
    const resolved = await this.resolve(input.body);
    return this.write(async (tx, changed) => {
      const created = await tx.db.comments.create({
        issueId: issue,
        authorId: this.viewerId,
        ...resolved,
        public: input.public ?? false,
        editedAt: null,
      });
      await changed("commented", created);
      return created;
    });
  }

  private async changeable(id: string): Promise<CommentDocument> {
    const found = await this.mongo.db.comments.findById(idOrInvalid(id, "id"));
    if (!found) throw commentNotFound();
    if (found.authorId !== this.viewerId && !this.moderator) {
      throw commentNotYours();
    }
    return found;
  }

  // A field left out stays as it is. A changed body is checked again.
  async edit(id: string, input: EditCommentInput): Promise<CommentDocument> {
    if (input.body == null && input.public == null) {
      throw invalid([{ path: "body", code: "validation.errors.required" }]);
    }
    const current = await this.changeable(id);
    const resolved =
      input.body != null && input.body.trim() !== current.body
        ? await this.resolve(input.body)
        : null;
    return this.write(async (tx, changed) => {
      const edited = await tx.db.comments.update(current._id, {
        ...resolved,
        ...(input.public != null && { public: input.public }),
        ...((resolved ||
          (input.public != null && input.public !== current.public)) && {
          editedAt: new Date(),
        }),
      });
      await changed("commentEdited", edited);
      return edited;
    });
  }

  // Answers the comment's id.
  async delete(id: string): Promise<string> {
    const current = await this.changeable(id);
    await this.write(async (tx, changed) => {
      await tx.db.comments.hardDelete(current._id);
      await changed("commentDeleted", current);
    });
    return current.id;
  }
}

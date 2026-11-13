import { fail } from "../../core/shared/errors";

export const commentNotFound = () =>
  fail("comments.errors.not-found", { status: 404 });

// Only the author or an admin changes a comment.
export const commentNotYours = () =>
  fail("comments.errors.not-yours", { status: 403 });

// Only the author sets or changes a comment's `public` flag (what the tracking
// page shows to the reporter): a moderator can delete a comment, not publish it.
export const publicAuthorOnly = () =>
  fail("comments.errors.public-author-only", { status: 403 });

// A mention names an account that is no member of the organisation: 400 on
// `body`, with the offending ids as param.
export const mentionNotMember = (ids: string[]) =>
  fail("comments.errors.mention-not-member", {
    status: 400,
    field: "body",
    params: {
      count: ids.length,
      ids: ids
        .slice(0, 5)
        .map((id) => id.slice(0, 40))
        .join(","),
    },
  });

// What other modules may import from comments.

export { commentNotFound, commentNotYours } from "./comments.errors";
export type { CommentDocument } from "./comments.model";
export {
  type ClientEntry,
  type CommentEntry,
  type CommentSource,
  registerCommentSource,
} from "./comments.sources";
export {
  type CommentChange,
  type CommentChangeHandler,
  registerCommentChange,
} from "./comments.usage";
export { withoutMarkers } from "./comments.utils";

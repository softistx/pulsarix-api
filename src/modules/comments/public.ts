// What other modules may import from comments.

export type { CommentDocument } from "./comments.model";
export {
  type CommentChange,
  type CommentChangeHandler,
  registerCommentChange,
} from "./comments.usage";
export { withoutMarkers } from "./mentions";

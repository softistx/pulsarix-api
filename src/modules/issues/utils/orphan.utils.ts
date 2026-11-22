import { type IssueDocument, typeOf } from "../issues.model";

// What a child keeps when its parent is deleted: no parent, and a Sub-task
// (which must have one) becomes a Task.
export function orphanPatch(child: IssueDocument): {
  parentId: null;
  type?: "task";
} {
  return typeOf(child) === "subTask"
    ? { parentId: null, type: "task" }
    : { parentId: null };
}

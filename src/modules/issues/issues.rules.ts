import type { IssueType } from "./issues.model";

// Why a (type, parent type) pair is refused; the codes of issues.errors.ts.
export type ParentRefusal =
  | "parent-not-allowed"
  | "parent-type-invalid"
  | "parent-required";

// The parent rules (plan §20.3): an Epic has no parent; a Story, a Task or a
// Bug may have an Epic as parent; a Sub-task must have a Story, a Task or a
// Bug as parent. `parent` is the parent's type, null for no parent.
export function parentRefusal(
  type: IssueType,
  parent: IssueType | null,
): ParentRefusal | null {
  if (type === "epic") return parent === null ? null : "parent-not-allowed";
  if (type === "subTask") {
    if (parent === null) return "parent-required";
    return parent === "epic" || parent === "subTask"
      ? "parent-type-invalid"
      : null;
  }
  if (parent === null) return null;
  return parent === "epic" ? null : "parent-type-invalid";
}

// Whether giving an issue the type `to`, from `from`, breaks the link of one
// of its children: a link that was fine and no longer is. A link that already
// broke the rules is left alone.
export function breaksChildren(
  from: IssueType,
  to: IssueType,
  children: readonly IssueType[],
): boolean {
  return children.some(
    (child) =>
      parentRefusal(child, from) === null && parentRefusal(child, to) !== null,
  );
}

// The progress of an issue's children: the done ones out of all of them, the
// cancelled ones left out of every count; `points` sums their story points
// (an Epic's total) and `pointsDone` those of the done ones.
export function progressOf(
  children: readonly { category: string; points: number | null }[],
): {
  done: number;
  total: number;
  points: number;
  pointsDone: number;
} {
  const counted = children.filter((child) => child.category !== "cancelled");
  const done = counted.filter((child) => child.category === "done");
  const sum = (list: typeof counted) =>
    list.reduce((total, child) => total + (child.points ?? 0), 0);
  return {
    done: done.length,
    total: counted.length,
    points: sum(counted),
    pointsDone: sum(done),
  };
}

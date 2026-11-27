import { fail } from "../../core/shared/errors";

export const issueNotFound = () =>
  fail("issues.errors.not-found", { status: 404 });

// The issue's project is archived: every write on its issues, comments and
// files is refused (409). Reading and `unarchiveProject` stay allowed.
export const projectArchived = () =>
  fail("issues.errors.project-archived", { status: 409 });

// A parent, a status or a label that is not the issue's project's, or an
// assignee that is no member, is an invalid input (`validation.errors.invalid`
// on the field); only a parent loop has its own code.
export const parentCycle = () =>
  fail("issues.errors.parent-cycle", { status: 409, field: "parentId" });

// An issue id sent with a `projectId` that is not its project's.
export const issueWrongProject = () =>
  fail("issues.errors.wrong-project", { status: 409, field: "projectId" });

// The move names neighbours that are not in the column, or not in order.
export const badPlacement = () =>
  fail("issues.errors.bad-placement", { status: 409 });

// The parent rules (plan §20.3, issues.rules.ts): all 409, on `parentId`
// except `type-breaks-children`, which is on `type`.
export const parentNotAllowed = () =>
  fail("issues.errors.parent-not-allowed", { status: 409, field: "parentId" });

export const parentTypeInvalid = () =>
  fail("issues.errors.parent-type-invalid", { status: 409, field: "parentId" });

export const parentRequired = () =>
  fail("issues.errors.parent-required", { status: 409, field: "parentId" });

// Story points (plan §20.5): off the Fibonacci scale is 400, on an Epic or a
// Sub-task 409; both on `points`.
export const pointsOffScale = () =>
  fail("issues.errors.points-off-scale", { status: 400, field: "points" });

export const pointsNotAllowed = () =>
  fail("issues.errors.points-not-allowed", { status: 409, field: "points" });

export const typeBreaksChildren = () =>
  fail("issues.errors.type-breaks-children", { status: 409, field: "type" });

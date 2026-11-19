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

// The move names neighbours that are not in the column, or not in order.
export const badPlacement = () =>
  fail("issues.errors.bad-placement", { status: 409 });

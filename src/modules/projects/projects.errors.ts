import { fail } from "../../core/shared/errors";

export const projectNotFound = () =>
  fail("projects.errors.not-found", { status: 404 });

export const keyTaken = (key: string) =>
  fail("projects.errors.key-taken", {
    params: { key },
    status: 409,
    field: "key",
  });

export const statusNotFound = () =>
  fail("projects.errors.status-not-found", { status: 404 });

export const statusNameTaken = (name: string) =>
  fail("projects.errors.status-name-taken", {
    params: { name },
    status: 409,
    field: "name",
  });

// Issues still stand on the status: move them first.
export const statusInUse = () =>
  fail("projects.errors.status-in-use", { status: 409 });

export const labelNotFound = () =>
  fail("projects.errors.label-not-found", { status: 404 });

export const labelNameTaken = (name: string) =>
  fail("projects.errors.label-name-taken", {
    params: { name },
    status: 409,
    field: "name",
  });

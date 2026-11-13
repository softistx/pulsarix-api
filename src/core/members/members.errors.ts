import { fail } from "../shared/errors";

export const memberNotFound = () =>
  fail("members.errors.not-found", { status: 404 });

// An organisation never loses its last active owner.
export const lastOwner = () =>
  fail("members.errors.last-owner", { status: 409 });

// Granting, changing or removing the owner role is the owners' alone.
export const ownerRequired = () =>
  fail("members.errors.owner-required", { status: 403 });

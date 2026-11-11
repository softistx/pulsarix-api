import { requireViewer } from "./guards";

// What a signed-in account may do whatever organisations it belongs to: not a
// role's permission (those are per organisation, in the manifests) but a right
// of the account itself. `organisation:create` is held by every signed-in
// account: it is how a first organisation is made (plan flow 1).
export const accountPermissions = ["organisation:create"] as const;
export type AccountPermission = (typeof accountPermissions)[number];

// The permissions of a signed-in account, for the `Viewer`.
export const permissionsOfAccount = (): readonly AccountPermission[] =>
  accountPermissions;

// Lets in a signed-in account that holds `permission` (401 otherwise).
export function requireAccountPermission(
  ctx: Parameters<typeof requireViewer>[0],
  permission: AccountPermission,
) {
  const viewer = requireViewer(ctx);
  if (!accountPermissions.includes(permission)) {
    throw new Error(`unknown account permission ${permission}`);
  }
  return viewer;
}

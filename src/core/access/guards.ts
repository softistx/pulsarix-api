import * as access from "@alxia/access";
import { fail } from "../shared/errors";

// The guards of @alxia/access, each refusal thrown as this API's coded error
// (`fail`): 401 `auth.errors.unauthenticated`, 403 `auth.errors.forbidden`
// (with the permission as param), and the scope's own 400
// `tenancy.errors.organization-required` and 404
// `tenancy.errors.unknown-organization` passed through. The order of the
// refusals is the package's: 401, then the scope's, then 403.
export const refuse = (refusal: access.Refusal) =>
  fail(refusal.code as Parameters<typeof fail>[0], {
    ...(Object.keys(refusal.params).length > 0 && {
      params: { ...refusal.params },
    }),
    status: refusal.status,
  });

export type { GuardContext } from "@alxia/access";

export const requireViewer: typeof access.requireViewer = (ctx) => {
  try {
    return access.requireViewer(ctx);
  } catch (error) {
    throw access.refusalMapper(refuse)(error);
  }
};
export const can: typeof access.can = access.withRefusals(refuse, access.can);
export const requireMember: typeof access.requireMember = access.withRefusals(
  refuse,
  access.requireMember,
);
export const requirePermission: typeof access.requirePermission =
  access.withRefusals(refuse, access.requirePermission);
export const requireAnyPermission: typeof access.requireAnyPermission =
  access.withRefusals(refuse, access.requireAnyPermission);
export const requireSelf: typeof access.requireSelf = access.withRefusals(
  refuse,
  access.requireSelf,
);
